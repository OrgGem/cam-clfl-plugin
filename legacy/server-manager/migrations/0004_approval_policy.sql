-- Pre-migration approvals must be previewed again because their policy was not bound.
UPDATE operations SET status='conflict',result='{"reason":"approval_policy_migrated_preview_again"}' WHERE status IN ('pending','approved');
ALTER TABLE approvals ADD COLUMN environment TEXT NOT NULL DEFAULT 'lab' CHECK(environment IN ('lab','production'));
