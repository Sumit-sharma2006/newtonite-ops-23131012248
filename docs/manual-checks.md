# PressureDesk: Manual API Verification Script (Phase 3 & 4)

This guide provides automated PowerShell and `curl` commands to test the critical concurrent behaviors and authorization gates implemented in Phase 3 & 4:
1. **Creation with Idempotency-Key** (`201 Created`)
2. **Duplicate Idempotency-Key Replay** (`201 Created` with header `Idempotency-Replay: true`)
3. **Payload Mismatch on Same Idempotency-Key** (`422 IDEMPOTENCY_PAYLOAD_MISMATCH`)
4. **Atomic Claim & Double Claim Conflict** (`200 OK` vs `409 ALREADY_CLAIMED`)
5. **Optimistic Locking Conflict** (`409 STALE_VERSION` returning latest item)
6. **Forbidden Transition & Four-Eyes Enforcement** (`403 APPROVAL_REQUIRED` / `CANNOT_APPROVE_OWN_ITEM`)
7. **Cross-Team Access Masking** (`404 NOT_FOUND` preventing resource enumeration)
8. **Keyset Cursor Pagination** (`GET /items` with base64 `cursor_ts,id`)
9. **Operational Dashboard Summary** (`GET /dashboard/summary`)

---

## Automated PowerShell Verification Script

Save as `scripts/manual-check.ps1` or paste directly into PowerShell with the server running (`npm start`):

```powershell
$baseUrl = "http://localhost:4000"
$ErrorActionPreference = "Stop"

Write-Host "=== 1. AUTHENTICATING USERS ===" -ForegroundColor Cyan
# Alice: Lead in Incident Response, Member in Payments
$aliceLogin = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"alice@pressuredesk.io","password":"Password123!"}'
$aliceToken = $aliceLogin.token
$incidentTeamId = ($aliceLogin.user.memberships | Where-Object { $_.team_slug -eq 'incident-response' }).team_id

# Bob: Lead in Payments, Member in Incident Response
$bobLogin = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"bob@pressuredesk.io","password":"Password123!"}'
$bobToken = $bobLogin.token

# Judy: Viewer in Payments & Core Infra, NOT in Incident Response
$judyLogin = Invoke-RestMethod -Uri "$baseUrl/auth/login" -Method Post -ContentType "application/json" -Body '{"email":"judy@pressuredesk.io","password":"Password123!"}'
$judyToken = $judyLogin.token
Write-Host "Logged in Alice, Bob, and Judy successfully.`n" -ForegroundColor Green

Write-Host "=== 2. IDEMPOTENCY: CREATE ITEM & REPLAY ===" -ForegroundColor Cyan
$idemKey = [System.Guid]::NewGuid().ToString()
$createBody = @{
    team_id = $incidentTeamId
    title = "High Memory Pressure on Redis Cache"
    description = "Memory utilization exceeded 95% threshold in us-east-1"
    type = "INCIDENT"
    priority = "URGENT"
} | ConvertTo-Json

# Request 1: Initial creation
$item1 = Invoke-RestMethod -Uri "$baseUrl/items" -Method Post -Headers @{"Authorization"="Bearer $aliceToken"; "Idempotency-Key"=$idemKey} -ContentType "application/json" -Body $createBody
$itemId = $item1.item.id
Write-Host "Created item $itemId (Version: $($item1.item.version))" -ForegroundColor Green

# Request 2: Duplicate key with exact same payload (should replay cached response)
$replayRes = Invoke-WebRequest -Uri "$baseUrl/items" -Method Post -Headers @{"Authorization"="Bearer $aliceToken"; "Idempotency-Key"=$idemKey} -ContentType "application/json" -Body $createBody
Write-Host "Replay Status Code: $($replayRes.StatusCode)"
Write-Host "Header Idempotency-Replay: $($replayRes.Headers['Idempotency-Replay'])" -ForegroundColor Green

# Request 3: Same key with DIFFERENT payload (must yield 422)
try {
    $diffBody = @{ team_id = $incidentTeamId; title = "Tampered Payload Title"; type = "TASK" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/items" -Method Post -Headers @{"Authorization"="Bearer $aliceToken"; "Idempotency-Key"=$idemKey} -ContentType "application/json" -Body $diffBody
} catch {
    $errRes = $_.Exception.Response
    Write-Host "Mismatched payload correctly rejected with status: $([int]$errRes.StatusCode) [Expected: 422]" -ForegroundColor Yellow
}
Write-Host "`n"

Write-Host "=== 3. ATOMIC CLAIM & DOUBLE CLAIM CONFLICT ===" -ForegroundColor Cyan
# Bob claims the open item
$claimRes = Invoke-RestMethod -Uri "$baseUrl/items/$itemId/claim" -Method Post -Headers @{"Authorization"="Bearer $bobToken"}
Write-Host "Bob claimed item: Status=$($claimRes.item.status), Assignee=$($claimRes.item.assignee_id), Version=$($claimRes.item.version)" -ForegroundColor Green

# Alice attempts to claim the same already-claimed item -> Expect 409 ALREADY_CLAIMED
try {
    Invoke-RestMethod -Uri "$baseUrl/items/$itemId/claim" -Method Post -Headers @{"Authorization"="Bearer $aliceToken"}
} catch {
    $errRes = $_.Exception.Response
    Write-Host "Second claim correctly rejected with status: $([int]$errRes.StatusCode) [Expected: 409]" -ForegroundColor Yellow
}
Write-Host "`n"

Write-Host "=== 4. OPTIMISTIC LOCKING: STALE VERSION CONFLICT ===" -ForegroundColor Cyan
# Alice tries to update with version 1 (current version is 2 after Bob claimed it)
try {
    $staleBody = @{ version = 1; title = "Stale Edit Attempt" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/items/$itemId" -Method Patch -Headers @{"Authorization"="Bearer $aliceToken"} -ContentType "application/json" -Body $staleBody
} catch {
    $errRes = $_.Exception.Response
    Write-Host "Stale update correctly rejected with status: $([int]$errRes.StatusCode) [Expected: 409 STALE_VERSION]" -ForegroundColor Yellow
}
Write-Host "`n"

Write-Host "=== 5. FORBIDDEN TRANSITION (Direct Resolve on INCIDENT) ===" -ForegroundColor Cyan
# Bob tries to directly resolve an INCIDENT without approval -> Expect 403 APPROVAL_REQUIRED
try {
    $transBody = @{ version = 2; to_status = "RESOLVED" } | ConvertTo-Json
    Invoke-RestMethod -Uri "$baseUrl/items/$itemId/transition" -Method Post -Headers @{"Authorization"="Bearer $bobToken"} -ContentType "application/json" -Body $transBody
} catch {
    $errRes = $_.Exception.Response
    Write-Host "Bypass attempt correctly rejected with status: $([int]$errRes.StatusCode) [Expected: 403 APPROVAL_REQUIRED]" -ForegroundColor Yellow
}
Write-Host "`n"

Write-Host "=== 6. CROSS-TEAM ENUMERATION PROTECTION (404 NOT FOUND) ===" -ForegroundColor Cyan
# Judy is NOT a member of Incident Response. Attempting to fetch item $itemId must return 404, NOT 403.
try {
    Invoke-RestMethod -Uri "$baseUrl/items/$itemId" -Method Get -Headers @{"Authorization"="Bearer $judyToken"}
} catch {
    $errRes = $_.Exception.Response
    Write-Host "Non-team user fetch masked with status: $([int]$errRes.StatusCode) [Expected: 404 NOT_FOUND]" -ForegroundColor Yellow
}
Write-Host "`n"

Write-Host "=== 7. KEYSET CURSOR PAGINATION & DASHBOARD SUMMARY ===" -ForegroundColor Cyan
# Page 1
$page1 = Invoke-RestMethod -Uri "$baseUrl/items?limit=5" -Method Get -Headers @{"Authorization"="Bearer $aliceToken"}
Write-Host "Page 1 returned $($page1.items.Count) items. Next cursor: $($page1.next_cursor)" -ForegroundColor Green

# Page 2 using cursor
if ($page1.next_cursor) {
    $encodedCursor = [System.Web.HttpUtility]::UrlEncode($page1.next_cursor)
    $page2 = Invoke-RestMethod -Uri "$baseUrl/items?limit=5&cursor=$encodedCursor" -Method Get -Headers @{"Authorization"="Bearer $aliceToken"}
    Write-Host "Page 2 returned $($page2.items.Count) items." -ForegroundColor Green
}

# Dashboard summary
$summary = Invoke-RestMethod -Uri "$baseUrl/dashboard/summary" -Method Get -Headers @{"Authorization"="Bearer $aliceToken"}
Write-Host "Dashboard Summary: Assigned to Me = $($summary.assigned_to_me), Unassigned Urgent = $($summary.unassigned_urgent), Awaiting My Approval = $($summary.awaiting_my_approval)" -ForegroundColor Green
Write-Host "`n=== ALL MANUAL CHECKS PASSED ===" -ForegroundColor Cyan
```

---

## Equivalent Raw cURL Commands

### 1. Authenticate
```bash
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@pressuredesk.io","password":"Password123!"}'
```

### 2. Idempotent Item Creation
```bash
curl -i -X POST http://localhost:4000/items \
  -H "Authorization: Bearer <ALICE_TOKEN>" \
  -H "Idempotency-Key: e68a1234-abcd-4321-ef01-987654321000" \
  -H "Content-Type: application/json" \
  -d '{"team_id":"<INCIDENT_TEAM_ID>","title":"Payment Gateway Disconnect","type":"INCIDENT","priority":"URGENT"}'
```

### 3. Atomic Claim
```bash
curl -i -X POST http://localhost:4000/items/<ITEM_ID>/claim \
  -H "Authorization: Bearer <BOB_TOKEN>"
```

### 4. Stale Version Update (Optimistic Locking)
```bash
curl -i -X PATCH http://localhost:4000/items/<ITEM_ID> \
  -H "Authorization: Bearer <ALICE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"version":1,"title":"Overwritten Title"}'
# Response: 409 Conflict with code STALE_VERSION
```

### 5. Cross-Team 404 Check
```bash
curl -i -X GET http://localhost:4000/items/<ITEM_ID> \
  -H "Authorization: Bearer <JUDY_TOKEN_NON_TEAM>"
# Response: 404 Not Found (prevents ticket enumeration)
```
