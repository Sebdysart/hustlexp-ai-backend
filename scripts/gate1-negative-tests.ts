/**
 * Gate-1 Negative Path Tests - Node.js version
 * Runs faster than bash/curl
 */

const HOST = "https://hustlexp-ai-backend-production.up.railway.app";

const TOKENS = {
    HUSTLER: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6Imh1c3RsZXIiLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vaHVzdGxleHAtZmx5LW5ldyIsImF1ZCI6Imh1c3RsZXhwLWZseS1uZXciLCJhdXRoX3RpbWUiOjE3NjUzNjA1NDIsInVzZXJfaWQiOiJ0ZXN0LWh1c3RsZXItMDAxIiwic3ViIjoidGVzdC1odXN0bGVyLTAwMSIsImlhdCI6MTc2NTM2MDU0MiwiZXhwIjoxNzY1MzY0MTQyLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.Yp2eSly9UjMh32NIiTrd7ZlNzLZjNC6mfrJpkiaQpzNWEpOb0aYnkMjkP5-3xy6hfjAUtxNeA9ur0qo3vpH3slaZyLWH6pgKqtiqmG4g7qSUPxuce6iNFvlzaewPFuo6b30tFOMkNOze00iEboCr9JqWNshEDeMnfSccO-G09Z5yYHyBXXe0Zo5dzs9PUX_vlPQQmHHwFGpndGD_x9pWnS3i3dvE2OgEv2v-4dyxvN5eq0OZHO2YYve92nhswe1ASvDWLOsr5uuRsl5hVkDIQMpE7tQRpBqvLC7DSewNIONvP-53hOnlJCEb8dpcBevnmbKVJQ_dEn0lB0Xb8K82og",
    POSTER: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6InBvc3RlciIsImlzcyI6Imh0dHBzOi8vc2VjdXJldG9rZW4uZ29vZ2xlLmNvbS9odXN0bGV4cC1mbHktbmV3IiwiYXVkIjoiaHVzdGxleHAtZmx5LW5ldyIsImF1dGhfdGltZSI6MTc2NTM2MDU0MiwidXNlcl9pZCI6InRlc3QtcG9zdGVyLTAwMSIsInN1YiI6InRlc3QtcG9zdGVyLTAwMSIsImlhdCI6MTc2NTM2MDU0MiwiZXhwIjoxNzY1MzY0MTQyLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.a8X8_mV93CDB_F7C3Sioz4MgzkaH9qAJGGUHzSQYU9pSty2kklnsNcGTXp7jdSdAbneoSHQhI0FMTEXLuhenbaPBZvv_Svx4QUvjxPAaouOQXq-2uMy17Jcx3elvt7r5eqXFIk7doETZOB-zp0fn2UXcJ_a9K6wl7tQBADWUGAGCftd4fTl8VLkbJCO3LWm_-tRC6kgT9taLrtg8TnU8fsOvaT4jZ59N3XmWHirY90Oj6thf8IX96esnHoKB2isY_TZvqQaH2XqBuo0kS8cPwz0BR2j6o3PVFM8cD44lDb4uTG3CNVxF8pBgRJTAvgRSg1NeaAmKBsNxcyKW_4DC8Q",
    ADMIN: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwicm9sZSI6ImFkbWluIiwiaXNzIjoiaHR0cHM6Ly9zZWN1cmV0b2tlbi5nb29nbGUuY29tL2h1c3RsZXhwLWZseS1uZXciLCJhdWQiOiJodXN0bGV4cC1mbHktbmV3IiwiYXV0aF90aW1lIjoxNzY1MzYwNTQzLCJ1c2VyX2lkIjoidGVzdC1hZG1pbi0wMDEiLCJzdWIiOiJ0ZXN0LWFkbWluLTAwMSIsImlhdCI6MTc2NTM2MDU0MywiZXhwIjoxNzY1MzY0MTQzLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7fSwic2lnbl9pbl9wcm92aWRlciI6ImN1c3RvbSJ9fQ.cFnibHwaUbc_JyQDW7jd53c3cgm6akPOTMDuZgvmT2Qf7WhOSzcVwcmHGe58Z3Vl2LJQpZA6suZG5WjMWJEf2cSTdV5b9z29j_ztKEXi6NKVFGdNsvhWKm_QeNvvM2--uQZzar0hGQqcBhpglDHY63a01Vfl74Fes_EwOwE0GUVGbwJ84pRANyqBHuaCK4BRP6bUIdBn8meiqSeB--k_0rjuDFrlf8wfQu23YFhSiJ_CoZDw8TmlriIXgt--5mnJJ5TR_0l5bHkPbkproqX2G_6qD9F8LpUmNu-7fBSHDR9CNUibwWh0dU0P4dm7xE03GfnnSpiHx2RymUDjcDgqvA",
    RANDOM: "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijk1MTg5MTkxMTA3NjA1NDM0NGUxNWUyNTY0MjViYjQyNWVlYjNhNWMiLCJ0eXAiOiJKV1QifQ.eyJ0ZXN0QWNjb3VudCI6dHJ1ZSwiaXNzIjoiaHR0cHM6Ly9zZWN1cmV0b2tlbi5nb29nbGUuY29tL2h1c3RsZXhwLWZseS1uZXciLCJhdWQiOiJodXN0bGV4cC1mbHktbmV3IiwiYXV0aF90aW1lIjoxNzY1MzYwNTQzLCJ1c2VyX2lkIjoidGVzdC1yYW5kb20tMDAxIiwic3ViIjoidGVzdC1yYW5kb20tMDAxIiwiaWF0IjoxNzY1MzYwNTQzLCJleHAiOjE3NjUzNjQxNDMsImZpcmViYXNlIjp7ImlkZW50aXRpZXMiOnt9LCJzaWduX2luX3Byb3ZpZGVyIjoiY3VzdG9tIn19.iu4CWEZFN3vbY6J2gBdV425PpHSHFSce8XUSgGi8UZfoff9qkHEmGarpY99vsCXZR0SrDM4Aan25Y9PqppiHYux1PNcoGAhXDQzshyUI9GT_XurLMwes4UN9VpfkgdoN9_whwygztMHMFyUtg77-OLaGvdFNmwYg7jSPiX40_m3pfICVea4wzLsxi969aejTez7H9RaKP17njam5y17slNKnHD8qXu_VDpO3CWarq9q_IT7XA7cQ6cX64X9W9158J2OingpsG7xObc1JbcCV0n_olhqTQ-V2TDMZnduGbgNhhdQz6gll7HKv35fi8qZeQuSFStll0CQQN7Ml2gwTzA"
};

interface TestResult {
    name: string;
    expected: string;
    actual: string;
    status: number;
    pass: boolean;
}

async function runTest(
    name: string,
    method: string,
    path: string,
    token: string | null,
    body: object | null,
    expectStatus: number[]
): Promise<TestResult> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    try {
        const res = await fetch(`${HOST}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        const pass = expectStatus.includes(res.status);
        return { name, expected: expectStatus.join("|"), actual: text.slice(0, 100), status: res.status, pass };
    } catch (e: any) {
        return { name, expected: expectStatus.join("|"), actual: e.message, status: 0, pass: false };
    }
}

async function main() {
    console.log("=== GATE-1 NEGATIVE PATH TESTS ===\n");
    const results: TestResult[] = [];

    // Phase 2: Auth Negative Paths
    console.log("PHASE 2: AUTH NEGATIVE PATHS\n");

    results.push(await runTest("T1: Hustler→escrow/create", "POST", "/api/escrow/create", TOKENS.HUSTLER, { taskId: "t1", amount: 100 }, [403]));
    results.push(await runTest("T2: Poster→connect/create", "POST", "/api/stripe/connect/create", TOKENS.POSTER, { userId: "p1", email: "p@t.com" }, [403]));
    results.push(await runTest("T3: No token→escrow/create", "POST", "/api/escrow/create", null, { taskId: "t1", amount: 100 }, [401]));
    results.push(await runTest("T4: Random→escrow/create", "POST", "/api/escrow/create", TOKENS.RANDOM, { taskId: "t1", amount: 100 }, [401, 403]));
    results.push(await runTest("T5: Poster→hustler status", "GET", "/api/stripe/connect/test-hustler-001/status", TOKENS.POSTER, null, [401, 403]));

    // Phase 2B: Owner Boundary
    console.log("\nPHASE 2B: OWNER BOUNDARY\n");

    results.push(await runTest("T6: Random→hustler status", "GET", "/api/stripe/connect/test-hustler-001/status", TOKENS.RANDOM, null, [401, 403]));
    results.push(await runTest("T7: No auth→connect status", "GET", "/api/stripe/connect/test-hustler-001/status", null, null, [401]));

    // Phase 3: Out-of-Order
    console.log("\nPHASE 3: OUT-OF-ORDER\n");

    results.push(await runTest("T8: Approve non-existent", "POST", "/api/proof/validated/fake-task/approve", TOKENS.POSTER, null, [400, 404]));
    results.push(await runTest("T9: Refund non-existent", "POST", "/api/proof/validated/fake-task/reject", TOKENS.POSTER, { reason: "x", action: "refund" }, [400, 404]));

    // Phase 3B: Admin Protection
    console.log("\nPHASE 3B: ADMIN PROTECTION\n");

    results.push(await runTest("T10: Poster→admin/disputes", "GET", "/api/admin/disputes", TOKENS.POSTER, null, [401, 403]));
    results.push(await runTest("T11: Hustler→admin/users", "GET", "/api/admin/users", TOKENS.HUSTLER, null, [401, 403]));
    results.push(await runTest("T12: Admin→admin/disputes", "GET", "/api/admin/disputes", TOKENS.ADMIN, null, [200]));
    results.push(await runTest("T13: Random→force-refund", "POST", "/api/admin/tasks/t1/force-refund", TOKENS.RANDOM, { reason: "x" }, [401, 403]));

    // Summary
    console.log("\n=== RESULTS ===\n");
    let pass = 0, fail = 0;
    for (const r of results) {
        const icon = r.pass ? "✅" : "❌";
        console.log(`${icon} ${r.name}: HTTP ${r.status} (expected ${r.expected})`);
        if (!r.pass) console.log(`   Body: ${r.actual}`);
        r.pass ? pass++ : fail++;
    }

    console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
    if (fail === 0) console.log("✅ ALL NEGATIVE PATH TESTS PASSED");
    else console.log("❌ SOME TESTS FAILED");
}

main().catch(console.error);
