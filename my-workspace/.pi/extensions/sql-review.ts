/**
 * SQL Review Extension (minimal example)
 *
 * Registers a /sqlreview command that prints the workspace SQL rules
 * as a reminder before asking Pi to review velocity/SQL code.
 *
 * Placement: my-workspace/.pi/extensions/ (project-local, hot-reloadable via /reload)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RULES = [
	"Velocity: no #set, use inline expressions and $!{} for null-safe output",
	"SQL: LEFT JOIN to preserve left rows; align UNION columns in order and alias",
	"Simplify: remove unused JOINs, CTEs, fields and dead code",
	"Explain: list changed JOIN / UNION semantics and row-count impact",
].join("\n");

export default function sqlReviewExtension(pi: ExtensionAPI) {
	pi.registerCommand("sqlreview", {
		description: "Print SQL/Velocity review rules, then ask Pi to review current changes",
		handler: async (_args, ctx) => {
			ctx.ui.notify("SQL review rules:\n" + RULES, "info");
		},
	});
}
