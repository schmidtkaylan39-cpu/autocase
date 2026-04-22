import { parseReviewerOutput } from "./parser.mjs";

const nextActionByVerdict = Object.freeze({
  approve: "advance_to_verifier",
  retry: "return_to_executor",
  comment_only: "hold_for_explicit_approval",
  reject: "stop_and_replan"
});

function buildBlockedDecision(reason, details = {}) {
  return {
    approved: false,
    blocked: true,
    failClosed: true,
    nextAction: "stop_and_replan",
    reason,
    ...details
  };
}

export function evaluateReviewerGate(reviewerOutput) {
  const verdict = reviewerOutput.verdict;
  const approved = verdict === "approve";
  return {
    approved,
    blocked: !approved,
    failClosed: reviewerOutput.failClosed !== false,
    verdict,
    nextAction: nextActionByVerdict[verdict],
    reason: reviewerOutput.releaseDecision?.reason
      ?? (approved
        ? "Reviewer approved the change."
        : "Reviewer did not approve the change; fail-closed gate remains closed.")
  };
}

export function resolveReviewerGate(rawText) {
  try {
    const reviewerOutput = parseReviewerOutput(rawText);
    const decision = evaluateReviewerGate(reviewerOutput);

    if (!decision.failClosed) {
      return buildBlockedDecision(
        "Reviewer output disabled fail-closed mode; gate stays closed.",
        { verdict: reviewerOutput.verdict, output: reviewerOutput }
      );
    }

    if (reviewerOutput.verdict === "approve" && reviewerOutput.releaseDecision?.canProceed !== true) {
      return buildBlockedDecision(
        "Reviewer returned approve without a positive release decision.",
        { verdict: reviewerOutput.verdict, output: reviewerOutput }
      );
    }

    if (reviewerOutput.verdict !== "approve" && reviewerOutput.releaseDecision?.canProceed === true) {
      return buildBlockedDecision(
        "Reviewer attempted to open the gate without approve.",
        { verdict: reviewerOutput.verdict, output: reviewerOutput }
      );
    }

    return {
      ...decision,
      output: reviewerOutput
    };
  } catch (error) {
    return buildBlockedDecision(
      error instanceof Error ? error.message : "Reviewer output could not be parsed.",
      { parseError: error instanceof Error ? error.message : String(error) }
    );
  }
}

