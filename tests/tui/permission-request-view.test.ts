import { describe, expect, it, vi } from "vitest";
import { approvalChoices, parseApprovalReverseRequest } from "../../src/tui/approval.ts";
import { ListSelectionModal } from "../../src/tui/components/list-selection-modal.ts";
import { PermissionRequestView } from "../../src/tui/components/permission-request-view.ts";

function shellRequest() {
	const request = parseApprovalReverseRequest({
		requestType: "permission",
		toolName: "bash",
		summary: "Run the complete check",
		cwd: "/workspace",
		requests: [{ kind: "shell", command: "npm run check", cwd: "/workspace", analysis: "known" }],
	});
	if (request === undefined) throw new Error("fixture permission request is invalid");
	return request;
}

describe("PermissionRequestView", () => {
	it("uses the shared secondary selection view structure", () => {
		const request = shellRequest();
		const view = new PermissionRequestView({ request, choices: approvalChoices(request), onSelect: vi.fn(), onCancel: vi.fn() });
		expect(view).toBeInstanceOf(ListSelectionModal);
	});

	it.each([
		["y", { decision: "allow-once" }],
		["p", { decision: "allow-with-prefix-rule", prefixRule: ["npm", "run", "check"] }],
		["\x1b", { decision: "deny" }],
	] as const)("maps the %j shortcut to its displayed decision", (input, expected) => {
		const request = shellRequest();
		const onSelect = vi.fn();
		const view = new PermissionRequestView({ request, choices: approvalChoices(request), onSelect, onCancel: vi.fn() });
		view.handleInput(input);
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ decision: expected }));
	});
});
