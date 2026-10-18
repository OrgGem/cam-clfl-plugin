# Vận hành

## Cấu hình staging

1. Tạo Google OAuth web client với callback `https://YOUR_DOMAIN/auth/google/callback`. Cấu hình consent/test users theo chính sách Google. Chọn client type backend; secret chỉ ở Worker.
2. Tạo Cloudflare OAuth client, Authorization Code, `client_secret_basic`, callback `https://YOUR_DOMAIN/auth/cloudflare/callback`. Lấy scope ID đúng từ `/client/v4/oauth/scopes`/dashboard: account discovery, zones/DNS read+edit, Workers scripts read, D1 read, Tunnel read, OIDC `openid` và `offline_access` để có userinfo/refresh token. Không dùng tên scope phỏng đoán. Đặt toàn bộ chuỗi vào `CF_SCOPES`.
3. Client private chỉ cho thành viên account sở hữu client authorize. Với danh tính ngoài account đó, cần domain verification + public client. Chuyển public không đảo ngược: đây là quyết định triển khai của chủ account, không nằm trong migration hay script repo.
4. Tạo D1 staging bằng `npx wrangler d1 create gem-cloudflare-manager-staging`; điền database ID thật vào config. Đặt `APP_ORIGIN` là HTTPS origin, không trailing slash; Google/Cloudflare client ID và `CF_SCOPES` thật. `MCP_CLIENT_ID` là ID được cấu hình cho ChatGPT custom OAuth; `MCP_REDIRECT_URIS` là allowlist callback chính xác, ngăn cách dấu phẩy. Lấy callback từ màn hình ChatGPT, không mặc định tin URL mẫu.
5. Secret cho control: `GOOGLE_CLIENT_SECRET`, `CF_CLIENT_SECRET`, `CREDENTIAL_KEYS`. Gateway cần `CF_CLIENT_SECRET`, `CREDENTIAL_KEYS`. `CREDENTIAL_KEYS` là JSON map version → base64url 32 byte AES key, ví dụ `{"v1":"<random 32 bytes, base64url>"}`. `KEY_VERSION` chọn key đang dùng để ghi. Tạo key bằng CSPRNG; lưu bản sao trong secret manager, không commit hay đưa lên issue/chat.

Local dùng file `.dev.vars` bị ignore:

```dotenv
GOOGLE_CLIENT_SECRET="..."
CF_CLIENT_SECRET="..."
CREDENTIAL_KEYS='{"v1":"..."}'
```

Remote dùng `npx wrangler secret put NAME`. Với gateway thêm `--config wrangler.gateway.jsonc`. Không đặt secret vào `[vars]`. Dữ liệu secret không cần xuất hiện trên CLI output.

## Triển khai

```sh
npm ci
npm run check
npx wrangler d1 export DB --remote --output /secure-backup/gem-before-migration.sql
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy --dry-run
npx wrangler deploy
```

Lần đầu DB trống không cần export. D1/Wrangler lưu migration ledger; chạy lại `migrations apply` không chạy lại ALTER. Không chạy từng SQL migration thủ công trên DB đã có ledger.

Để tách gateway: điền cùng D1 ID và origin vào `wrangler.gateway.jsonc`, đặt hai secret gateway, deploy bằng `npx wrangler deploy --config wrangler.gateway.jsonc`. Cấu hình Workers route **chính xác** `YOUR_DOMAIN/mcp` tới gateway; control giữ domain và OAuth metadata. Gateway không cần browser session, Google secret hay assets. Kiểm tra request metadata/resource đều trỏ cùng HTTPS origin. Khi đổi scope/keyring, đồng bộ hai service trước khi chuyển `KEY_VERSION`.

Production phải có Worker names, domain, OAuth clients, secrets và D1 khác staging. Tạo config production riêng từ template staging, không tái sử dụng database ID. Không chạy fixture E2E với `--remote`. CI chỉ build/test, deployment do operator thực hiện sau khi checklist đạt.

## Onboarding

1. Đăng nhập Google, vào Connections → Add connection, authorize Cloudflare.
2. Đọc identity và account ID được discovery; Confirm chỉ khi đúng. Các connection chưa confirm không dùng được cho tài nguyên.
3. Đặt alias và environment trên Accounts. Đặt production để bắt buộc nhập `connection_id/account_id/zone_id` khi duyệt.
4. Owner tạo invitation theo email; recipient đăng nhập và Accept trên Users & Access. Owner credential cấp grant rõ cho từng account; read và DNS là hai grant riêng. Viewer chỉ đọc dù còn grant DNS; Operator/Admin/Owner vẫn cần grant credential của người khác.
5. Trên ChatGPT Plugins, Add custom MCP server `https://YOUR_DOMAIN/mcp`, cấu hình OAuth authorization/token endpoint theo discovery và client ID/redirect URI allowlist; đăng nhập Google trước khi mở consent nếu browser chưa có session. Consent token có hạn 1 giờ; hết hạn kết nối lại. MVP chưa có refresh token cho ChatGPT.
6. Thay URL trong `plugin/mcp.json`, kiểm tra `npm run validate:plugin`, cài package theo host/plugin marketplace. Nếu ChatGPT yêu cầu connector mapping `plugin_asdk_app...`, dùng ID nhận từ bước đăng ký thật trong metadata OpenAI; không tạo ID giả.

## Approval và DNS

ChatGPT tạo preview với UUID idempotency key. UI hiển thị diff, account/connection/zone và hạn duyệt. Người tạo operation đăng nhập UI để approve; MVP không có approver thay thế. ChatGPT gọi apply chỉ bằng operation ID. Operation quá hạn hoặc dữ liệu đổi phải preview mới. Record rename/type change, xóa DNS và no-op bị chặn.

`uncertain`/`applying` không phải “chưa thực hiện”. Gọi lại apply cùng ID để đọc lại; không tự tạo operation khác, không reset state về approved. Nếu không xác minh được: operator đối chiếu API và audit, giữ lock, rồi xử lý thủ công có bằng chứng. Cloudflare DNS không cung cấp transaction/conditional write cho toàn quy trình; thay đổi ngoài ứng dụng vẫn có thể chen giữa lần kiểm tra và API write.

`verified:true` là API readback. Kiểm tra public DNS riêng bằng resolver/authoritative nameserver sau TTL phù hợp. DNS proxied trả IP Cloudflare; bản ghi chưa delegated không kiểm chứng được như production. Không dùng một độ trễ cố định cho mọi zone.

## Reconnect, revoke, lỗi

- Reconnect cùng identity: không tự chuyển credential hoặc nâng quyền; subject phải trùng. Sau discovery, account không còn được cấp sẽ bị đánh dấu unavailable. Xác nhận lại identity/accounts; alias cũ giữ nguyên. Pending operations phải kiểm tra quyền lại.
- Revoke: quyền local mất ngay; upstream revoke được báo riêng nếu chưa xác nhận được. Có thể thu hồi trực tiếp Cloudflare dashboard; lần request tiếp theo upstream có thể trả permission denied, app không thử credential khác.
- 429: dừng gửi thêm request trên connection, backoff có jitter phía caller. Không retry DNS bằng operation ID mới. Pagination đọc mỗi trang 50; account discovery tối đa 5.000 account, vượt giới hạn yêu cầu thu hẹp scope.
- Refresh concurrent: một connection chỉ có một refresh claim. Request cạnh tranh nhận 409 để retry sau. Crash/timeout trong refresh có thể đã rotate token: connection không tự replay refresh; reconnect. `refreshing` kéo dài cũng xử lý bằng reconnect.
- Browser sign out chỉ xóa session browser. “Revoke all ChatGPT access tokens” vô hiệu toàn bộ MCP bearer của user ngay request tiếp theo.

## Key rotation, retention và recovery

1. Sao lưu DB + keyring cũ theo cơ chế riêng, hạn chế quyền đọc backup. DB chứa credential ciphertext; mất key thì không khôi phục được credential.
2. Thêm key mới vào `CREDENTIAL_KEYS` trên cả hai Worker, giữ các key cũ. Sau đó đổi `KEY_VERSION`. Connection refresh/reconnect sẽ được mã hóa lại bằng key mới. Chỉ bỏ key cũ sau khi DB không còn row dùng version đó và backup policy cho phép.
3. Trước migration remote: export D1, ghi commit/version đang chạy. Test restore vào D1 staging riêng; giữ origin/clients staging để không dùng nhầm token production. Nếu migration lỗi, dừng writes, kiểm tra migration ledger; forward-fix hoặc restore DB vào database mới rồi đổi binding cả hai Worker. Không rollback SQL tùy ý giữa lúc gateway đang nhận write.
4. Restore backup cũ có thể phục hồi approval hoặc token đã thu hồi. Trước khi mở lại writes: xóa `sessions`, `access_tokens`, `oauth_codes`, `oauth_sessions`; chuyển pending/approved/applying/uncertain operations sang trạng thái cần điều tra (không tự chạy lại), thu hồi/reconnect credential có refresh rotation không khớp. Đối chiếu upstream DNS trước khi bỏ lock. Audit của DB mới chỉ chứng minh đến thời điểm backup.
5. MVP chưa có scheduler retention. Định kỳ xóa session/code/token/state hết hạn bằng SQL có điều kiện thời gian; giữ operations/approvals/audit theo chính sách doanh nghiệp. Chỉ xóa API lease quá hạn, không xóa lock DNS uncertain để “sửa lỗi”. Giám sát D1 size, rows read/write, CPU, latency, 429 và refresh errors trước khi chọn gói.

Nguồn đối chiếu: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Cloudflare OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), [OAuth endpoints](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/), [OpenAI MCP authentication](https://developers.openai.com/plugins/build/auth), [Plugin packaging](https://developers.openai.com/plugins/build/plugins).
