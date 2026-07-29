import { describe, expect, test } from "bun:test";
import { initializeWorkflow, memberDiscipline } from "@/domains/task/workflow";

const config: any = {
    groups: [{
        chat_id: "oc_delivery",
        name: "Demo Delivery Team",
        members: [
            { open_id: "ou_product", name: "产品", job_title: "高级产品经理" },
            { open_id: "ou_frontend", name: "前端", job_title: "前端工程师" },
            { open_id: "ou_qa", name: "测试", job_title: "QA测试工程师" },
            { open_id: "ou_content", name: "内容", job_title: "内容运营" },
            { open_id: "ou_manual", name: "人工覆盖", role: "产品", job_title: "后端开发" },
        ],
    }],
};

function draftTask(ownerOpenId: string): any {
    const member = config.groups[0].members.find((item: any) => item.open_id === ownerOpenId);
    return {
        id: `task-${ownerOpenId}`,
        title: "任务",
        creator_open_id: "ou_creator",
        creator_name: "创建人",
        primary_owner_open_id: ownerOpenId,
        primary_owner_name: member.name,
        assignee_open_ids: [ownerOpenId],
        assignee_names: [member.name],
        status: "pending_confirmation",
        priority: "P2",
        source_message_id: "om_1",
        source_group_id: "oc_delivery",
        created_at: "2026-07-14T00:00:00Z",
        updated_at: "2026-07-14T00:00:00Z",
    };
}

describe("task workflow member discipline", () => {
    test("classifies product and broad R&D job titles while preserving manual overrides", () => {
        expect(memberDiscipline(config, "ou_product")).toBe("product");
        expect(memberDiscipline(config, "ou_frontend")).toBe("development");
        expect(memberDiscipline(config, "ou_qa")).toBe("development");
        expect(memberDiscipline(config, "ou_content")).toBe("content");
        expect(memberDiscipline(config, "ou_manual")).toBe("product");
    });

    test("routes every non-product owner through the existing execution workflow", () => {
        for (const openId of ["ou_frontend", "ou_qa", "ou_content"]) {
            const workflow = initializeWorkflow(draftTask(openId), config, "2026-07-14T00:00:00Z");
            expect(workflow.pending_role).toBe("developer");
        }
        const productWorkflow = initializeWorkflow(draftTask("ou_product"), config, "2026-07-14T00:00:00Z");
        expect(productWorkflow.pending_role).toBe("product");
    });
});
