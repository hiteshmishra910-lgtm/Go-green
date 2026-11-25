# EcoVerify Security Specification

## Data Invariants

1. **Identity & Privilege Isolation**: No user may self-assign `role: "admin"` or `role: "collector"` during registration or profile updates. Only verified admins (`hiteshmishra910@gmail.com` or UIDs in `/admins/{uid}`) may promote users or approve collector applications.
2. **PII Protection**: Private user fields (`email`, `phone`, `address`) in `/users/{userId}` are readable only by the document owner or an admin. Public leaderboard entries in `/leaderboard/{userId}` contain zero PII. QR lookup cards in `/residentCards/{residentId}` are readable only by the resident owner, active collectors, or admins.
3. **Immutable Reward Integrity**: Residents cannot modify their own `rewardPoints` or write to `/rewardTransactions/{txId}`. Only active collectors (capped to valid per-collection category points and bound atomically to a valid collection record) or admins may issue reward transactions. Reward transactions are immutable once created.
4. **Terminal State Locking**: Once a `/collections/{collectionId}` document reaches `'collected'` or `'rejected'`, collectors and residents cannot modify it; only an admin can override or correct terminal states.
5. **Temporal Integrity & Path Hardening**: Every document ID matches `^[a-zA-Z0-9_\\-]+$` (up to 128 chars) and all `createdAt`/`updatedAt` timestamps must match `request.time`.

## The "Dirty Dozen" Adversarial Payloads

1. **Self-Promotion to Admin on Signup (`users/{uid}`)**: `{ uid, email, name, role: "admin", accountStatus: "active", rewardPoints: 0 }` -> `PERMISSION_DENIED`.
2. **Self-Promotion to Collector on Update (`users/{uid}`)**: `{ role: "collector", updatedAt: serverTimestamp() }` -> `PERMISSION_DENIED`.
3. **Direct Resident Reward Manipulation (`users/{uid}`)**: `{ rewardPoints: 999999, updatedAt: serverTimestamp() }` -> `PERMISSION_DENIED`.
4. **Resident Forging Reward Transaction (`rewardTransactions/{txId}`)**: `{ txId, residentUid: uid, points: 500, awardedByUid: uid, awardedByRole: "collector" }` -> `PERMISSION_DENIED`.
5. **Collector Modifying Terminal Collection (`collections/{id}` where status == 'collected')**: `{ status: "rejected", pointsAwarded: 0 }` -> `PERMISSION_DENIED`.
6. **Unverified Email Spoofing Admin**: Token with `email: "hiteshmishra910@gmail.com"` and `email_verified: false` -> `PERMISSION_DENIED`.
7. **PII Scraping List Query on `/users`**: Resident calling `getDocs(collection(db, "users"))` -> `PERMISSION_DENIED`.
8. **Shadow Field Injection on `/users/{uid}`**: `{ name: "Alice", isVerified: true, shadowAdmin: true }` -> `PERMISSION_DENIED`.
9. **Collector Awarding Excess Points (`users/{residentUid}`)**: Collector incrementing `rewardPoints` by `+500` in a single write -> `PERMISSION_DENIED`.
10. **Path Poisoning on Document ID**: Creating `collections/<1500-char-junk-id>` -> `PERMISSION_DENIED`.
11. **Backdated Timestamp Spoofing**: Creating collection with `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> `PERMISSION_DENIED`.
12. **Resident Creating Notification for Another User**: Resident writing `notifications/{id}` with `recipientUid: otherUid` -> `PERMISSION_DENIED`.
