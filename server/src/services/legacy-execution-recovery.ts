import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { isSupersededConversationRun } from "./agent-conversations.js";

type Run = typeof heartbeatRuns.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && run.errorCode === "ai_connection_busy" &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
  orphanedLocalLease?: {
    id: string;
    processPid: number | null;
    processGroupId: number | null;
    controllerBootId: string | null;
    controllerLeaseExpiresAt: Date | null;
    afterRelease?: () => Promise<void>;
  };
}) {
  const { db, run, status, patch } = input;
  const issueId =
    run.nativeIssueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [currentRun] = await tx
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)))
      .for("update");
    if (!currentRun || !(input.fromStatuses ?? [run.status]).includes(currentRun.status)) return null;

    const orphanedLease = input.orphanedLocalLease;
    let lockedLease: typeof environmentLeases.$inferSelect | null = null;
    if (orphanedLease) {
      // Missing process identity is missing telemetry, not proof of death.
      if (orphanedLease.processPid === null && orphanedLease.processGroupId === null) return null;
      const sameDate = (left: Date | null, right: Date | null) =>
        left === null ? right === null : right !== null && left.getTime() === right.getTime();
      if (
        currentRun.processPid !== orphanedLease.processPid ||
        currentRun.processGroupId !== orphanedLease.processGroupId ||
        currentRun.controllerBootId !== orphanedLease.controllerBootId ||
        !sameDate(currentRun.controllerLeaseExpiresAt, orphanedLease.controllerLeaseExpiresAt)
      ) return null;
      const [lockedOwnership] = await tx
        .select({ lease: environmentLeases, environmentDriver: environments.driver })
        .from(environmentLeases)
        .innerJoin(environments, eq(environments.id, environmentLeases.environmentId))
        .where(and(
          eq(environmentLeases.id, orphanedLease.id),
          eq(environmentLeases.companyId, run.companyId),
          eq(environmentLeases.heartbeatRunId, run.id),
        ))
        .for("update");
      lockedLease = lockedOwnership?.lease ?? null;
      if (
        !lockedLease ||
        !["active", "pending_cleanup"].includes(lockedLease.status) ||
        (lockedLease.provider !== null && lockedLease.provider !== "local") ||
        lockedOwnership?.environmentDriver !== "local" ||
        lockedLease.providerLeaseId !== null
      ) return null;
    }

    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    const [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          inArray(heartbeatRuns.status, input.fromStatuses ?? [run.status]),
        ),
      )
      .returning();
    if (!updated) return null;
    if (lockedLease) {
      await tx.update(environmentLeases).set({
        status: "expired",
        releasedAt: new Date(),
        cleanupStatus: "success",
        failureReason: "orphaned_terminal_local_run",
        updatedAt: new Date(),
      }).where(and(
        eq(environmentLeases.id, lockedLease.id),
        inArray(environmentLeases.status, ["active", "pending_cleanup"]),
        eq(environmentLeases.heartbeatRunId, run.id),
      ));
      await orphanedLease?.afterRelease?.();
    }
    if (task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
    const isCurrentReviewer = review?.status === "pending" &&
      review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
    if (
      task &&
      !isSupersededConversationRun(task, updated) &&
      (Boolean(task.assigneeAgentId) || isCurrentReviewer) &&
      !["done", "cancelled"].includes(task.status)
    ) {
      // Periodic stranded-work checks may revisit this terminal run before its
      // reconciled continuation is dispatched. Preserve the recorded decision.
      const [reconciled] = await tx.select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
        )).limit(1);
      if (reconciled) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction:
          "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}
