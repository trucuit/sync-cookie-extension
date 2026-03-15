# Function-Level Test Checklist (PAT-22)

Phạm vi quét:
- `src/background.ts`
- `src/lib/crypto.ts`
- `src/App.tsx`
- `src/components/PasswordDialog.tsx`

Quy ước:
- `Happy`: luồng chuẩn mong đợi.
- `Edge`: dữ liệu biên/ít gặp nhưng hợp lệ.
- `Error`: dữ liệu lỗi hoặc dependency throw/reject.

## Test Data Đề Xuất (dùng lại cho nhiều case)

```ts
const passwordStrong = 'S3cure!Pass#2026';
const passwordUnicode = 'Mật-khẩu🔐-đặc-biệt';
const wrongPassword = 'Wrong#Pass';

const activeTab = { id: 1, url: 'https://app.example.com/dashboard' };
const activeTabNoUrl = { id: 1, url: '' };

const cookiesFixture = [
  {
    name: 'sid',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: 1735689600,
  },
  {
    name: 'prefs',
    value: '{"theme":"dark"}',
    domain: '.example.com',
    path: '/',
    secure: false,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: 1735689600,
  },
];

const encryptedFileValid = {
  encrypted: true,
  version: '1.0.0',
  data: 'BASE64_DATA',
  iv: 'BASE64_IV',
  salt: 'BASE64_SALT',
};
```

## `src/background.ts`

### Module init (`chrome.runtime.onInstalled.addListener`, `chrome.runtime.onMessage.addListener`)
- [ ] Happy: import module đăng ký đúng 2 listeners.
  - Data: mock `chrome.runtime.*.addListener`.
  - Expected: mỗi listener được gọi đúng 1 lần.
- [ ] Edge: import lại sau `vi.resetModules()` vẫn đăng ký lại đúng 1 lần/run.
  - Data: import 2 lần trong 2 module context khác nhau.
  - Expected: không nhân đôi listener trong cùng context.
- [ ] Error: thiếu `chrome.runtime`.
  - Data: `globalThis.chrome = undefined`.
  - Expected: import throw rõ ràng (để phát hiện sai runtime sớm).

### onInstalled callback (anonymous function line 3)
- [ ] Happy: callback log `"Sync Cookie Extension installed"`.
  - Data: trigger callback đã đăng ký.
  - Expected: `console.log` nhận đúng message.
- [ ] Edge: callback trigger nhiều lần.
  - Data: gọi callback 3 lần.
  - Expected: log 3 lần, không mutate state global.
- [ ] Error: `console.log` throw.
  - Data: spy `console.log` và ép throw.
  - Expected: callback bubble lỗi (không swallow).

### onMessage callback (anonymous function line 8)
- [ ] Happy: request hợp lệ trả `{ success: true }` và return `true`.
  - Data: request `{ type: 'PING' }`, `sendResponse` spy.
  - Expected: log request, gọi `sendResponse({ success: true })`, return `true`.
- [ ] Edge: request `null` hoặc payload lớn.
  - Data: `request = null`; request object > 100KB.
  - Expected: vẫn phản hồi success + return true.
- [ ] Error: `sendResponse` throw.
  - Data: `sendResponse = vi.fn(() => { throw new Error('send failed'); })`.
  - Expected: callback throw; test ghi nhận lỗi để cân nhắc harden nếu cần.

## `src/lib/crypto.ts`

### `deriveKey(password, salt)` (internal)
- [ ] Happy: tạo `CryptoKey` AES-GCM 256 từ password + salt 16 bytes.
  - Data: `passwordStrong`, `salt = new Uint8Array(16).fill(1)`.
  - Expected: key type `secret`, usages gồm `encrypt/decrypt`.
- [ ] Edge: password rỗng, salt không chuẩn 16 bytes.
  - Data: `password=''`; salt 8 bytes, 32 bytes.
  - Expected: vẫn derive được key hợp lệ (PBKDF2 nhận nhiều salt length).
- [ ] Error: `crypto.subtle.importKey` hoặc `deriveKey` reject.
  - Data: mock subtle method reject.
  - Expected: function reject đúng error gốc.

### `encrypt(data, password)`
- [ ] Happy: mã hóa payload JSON/unicode thành `{data,iv,salt}` base64.
  - Data: `data = JSON.stringify({ hello: 'Xin chào 👋' })`, `passwordStrong`.
  - Expected: 3 field đều non-empty, decode IV=12 bytes, salt=16 bytes.
- [ ] Happy: round-trip với `decrypt`.
  - Data: encrypt rồi decrypt cùng password.
  - Expected: plaintext khôi phục giống 100%.
- [ ] Edge: `data=''`, payload lớn (>=1MB), password unicode.
  - Data: `''`; `'a'.repeat(1_000_000)`; `passwordUnicode`.
  - Expected: encrypt thành công, không mất dữ liệu khi decrypt lại.
- [ ] Edge: cùng input/password chạy nhiều lần cho output khác nhau.
  - Data: encrypt 2 lần cùng `data/password`.
  - Expected: `iv`, `salt`, `data` khác nhau.
- [ ] Error: `crypto.getRandomValues` throw hoặc derive key reject.
  - Data: mock throw/reject.
  - Expected: `encrypt` reject, caller xử lý error path.

### `decrypt(encrypted, password)`
- [ ] Happy: giải mã thành plaintext đúng.
  - Data: encrypted tạo từ `encrypt`.
  - Expected: string kết quả khớp input ban đầu.
- [ ] Edge: plaintext rỗng.
  - Data: encrypt `''` rồi decrypt.
  - Expected: trả `''`.
- [ ] Edge: payload có unicode/special chars.
  - Data: `{"note":"🔐 dữ liệu có dấu"}`.
  - Expected: decode UTF-8 đúng.
- [ ] Error: sai password.
  - Data: decrypt bằng `wrongPassword`.
  - Expected: reject (WebCrypto decrypt error).
- [ ] Error: data/iv/salt base64 hỏng hoặc bị tamper.
  - Data: sửa 1 ký tự trong `data`; `iv='@@@'`.
  - Expected: reject khi `atob` hoặc `subtle.decrypt`.
- [ ] Error: thiếu field.
  - Data: object thiếu `salt`/`iv`.
  - Expected: reject.

### `arrayBufferToBase64(buffer)` (internal)
- [ ] Happy: convert đúng cho `ArrayBuffer` và `Uint8Array`.
  - Data: bytes `[0, 255, 10, 13]`.
  - Expected: output base64 giống nhau cho cả 2 kiểu input.
- [ ] Edge: buffer rỗng.
  - Data: `new Uint8Array(0)`.
  - Expected: trả `''`.
- [ ] Error: `btoa` không tồn tại/throw.
  - Data: mock `globalThis.btoa` throw.
  - Expected: function throw.

### `base64ToArrayBuffer(base64)` (internal)
- [ ] Happy: decode base64 về bytes chính xác.
  - Data: `'AP8KDQ=='`.
  - Expected: bytes `[0,255,10,13]`.
- [ ] Edge: base64 rỗng.
  - Data: `''`.
  - Expected: trả buffer length 0.
- [ ] Error: base64 không hợp lệ.
  - Data: `'###invalid###'`.
  - Expected: `atob` throw.

### `generatePassword(length = 32)`
- [ ] Happy: default length 32 và chỉ chứa charset cho phép.
  - Data: gọi không truyền param.
  - Expected: length 32, match regex `^[A-Za-z0-9!@#$%^&*]+$`.
- [ ] Happy: custom length 64.
  - Data: `generatePassword(64)`.
  - Expected: length 64, charset hợp lệ.
- [ ] Edge: `length = 0`, `length = 1`.
  - Data: `0`, `1`.
  - Expected: `''` và 1 ký tự hợp lệ.
- [ ] Error: `length < 0` hoặc quá lớn (`>65536`).
  - Data: `-1`, `70000`.
  - Expected: throw `RangeError`/`QuotaExceededError`.
- [ ] Error: `crypto.getRandomValues` throw.
  - Data: mock throw.
  - Expected: function throw.

## `src/App.tsx` (UI component + handlers)

### `App()`
- [ ] Happy: render trạng thái đầu `syncStatus='idle'`, không hiện badge trạng thái.
  - Data: render component với mock chrome tối thiểu.
  - Expected: nút Export/Import/Sync hiển thị, badge ẩn.
- [ ] Edge: khi `syncStatus='syncing'`, nút Sync disabled + icon quay.
  - Data: trigger `handleSync`.
  - Expected: class disabled/animate-spin đúng.
- [ ] Error: child callback throw (từ `PasswordDialog` confirm).
  - Data: mock `encrypt/decrypt` throw.
  - Expected: App chuyển sang luồng `error`.

### `handleExportWithPassword(password)`
- [ ] Happy: export encrypted file theo domain tab active.
  - Data: `activeTab`, `cookiesFixture`, mock `encrypt` resolve.
  - Expected: gọi `chrome.tabs.query`, `chrome.cookies.getAll`, tạo Blob JSON có `encrypted=true`, download file `cookies-app.example.com-*.encrypted.json`, status `synced -> idle`.
- [ ] Edge: tab không có URL.
  - Data: `activeTabNoUrl`.
  - Expected: vào catch, status `error -> idle`.
- [ ] Edge: domain không có cookies.
  - Data: `chrome.cookies.getAll` trả `[]`.
  - Expected: vẫn export thành công file cookies rỗng.
- [ ] Edge: password unicode.
  - Data: `passwordUnicode`.
  - Expected: encrypt được gọi đúng password, output hợp lệ.
- [ ] Error: `chrome.tabs.query` reject / `chrome.cookies.getAll` reject / `encrypt` reject.
  - Data: mock từng dependency reject.
  - Expected: status `error`, không crash UI.
- [ ] Error: `URL.createObjectURL` throw.
  - Data: mock throw.
  - Expected: status `error`, không kẹt `syncing`.

### Inline callback `cookies.map(cookie => ({...}))` trong `handleExportWithPassword`
- [ ] Happy: map đầy đủ field cookie sang payload export.
  - Data: `cookiesFixture`.
  - Expected: output chứa đủ `name,value,domain,path,secure,httpOnly,sameSite,expirationDate`.
- [ ] Edge: cookie có field optional `expirationDate` undefined.
  - Data: cookie session không có `expirationDate`.
  - Expected: payload vẫn hợp lệ, không throw.
- [ ] Error: cookie object thiếu field bắt buộc (mock dữ liệu hỏng).
  - Data: `{ name: 'sid' } as any`.
  - Expected: test phát hiện payload thiếu để harden validation nếu cần.

### `handleImportWithPassword(password)`
- [ ] Happy: import file encrypted hợp lệ + confirm `true`.
  - Data: `pendingFile.text()` trả JSON encrypted; `decrypt` trả object có `cookiesFixture`; `confirm=true`.
  - Expected: lặp `chrome.cookies.set` cho từng cookie, alert success với số lượng imported, clear `pendingFile`, status `synced -> idle`.
- [ ] Edge: `pendingFile=null`.
  - Data: state mặc định.
  - Expected: return sớm, không gọi dependency.
- [ ] Edge: user bấm Cancel ở `confirm`.
  - Data: `confirm=false`.
  - Expected: status về `idle`, không gọi `chrome.cookies.set`.
- [ ] Edge: import một phần thành công.
  - Data: cookie thứ 2 `chrome.cookies.set` reject.
  - Expected: log warning, vẫn alert `imported < total`.
- [ ] Error: file không có `encrypted=true`.
  - Data: JSON thiếu cờ `encrypted`.
  - Expected: throw `'File is not encrypted'`, status `error`, clear `pendingFile`.
- [ ] Error: JSON parse fail hoặc decrypt fail (sai password/tamper data).
  - Data: text không phải JSON; `decrypt` reject.
  - Expected: alert lỗi với message phù hợp.
- [ ] Error: format sau decrypt không có `cookies[]`.
  - Data: `{ domain: 'example.com' }`.
  - Expected: throw `'Invalid cookie file format'`, status `error`.

### `handleExport()`
- [ ] Happy: mở dialog export.
  - Data: click nút Export.
  - Expected: `dialogType='export'`.
- [ ] Edge: đang mở import dialog.
  - Data: `dialogType='import'`.
  - Expected: chuyển sang `'export'`.
- [ ] Error: không có error path nội tại (pure state update).

### `handleImport()` + `input.onchange`
- [ ] Happy: tạo input file `.json`, click chọn file hợp lệ.
  - Data: mock `document.createElement('input')`, inject file JSON.
  - Expected: `pendingFile` set, `dialogType='import'`.
- [ ] Edge: user đóng file picker (không chọn file).
  - Data: `files=[]` hoặc `undefined`.
  - Expected: giữ nguyên state.
- [ ] Error: `document.createElement` throw.
  - Data: mock throw.
  - Expected: test ghi nhận throw để cân nhắc harden.

### `handleSync()`
- [ ] Happy: status `syncing -> synced -> idle`.
  - Data: fake timers.
  - Expected: chuyển state đúng mốc 1500ms và 2000ms tiếp theo.
- [ ] Edge: click nhanh nhiều lần.
  - Data: fire click liên tục.
  - Expected: khi `syncing` thì button disabled, không tạo thêm flow mới.
- [ ] Error: unmount trước khi timer chạy xong.
  - Data: trigger rồi unmount.
  - Expected: không warning memory leak (nên thêm cleanup nếu warning xuất hiện).

### Các callback timer nội bộ trong `App` (setTimeout)
- [ ] Happy: callback timer chạy đúng thứ tự trong các flow export/import/sync.
  - Data: fake timers + trigger từng flow.
  - Expected: state chuyển đúng chuỗi `syncing -> synced/error -> idle`.
- [ ] Edge: timer chồng lấp do user thao tác liên tục.
  - Data: trigger `handleSync`, sau đó trigger import/export fail.
  - Expected: trạng thái cuối cùng nhất quán (`idle`), không kẹt.
- [ ] Error: `alert` throw trong callback import.
  - Data: mock `window.alert` throw.
  - Expected: lỗi được thấy rõ trong test, tránh silent failure.

### Inline callback `onCancel` của import dialog
- [ ] Happy: đóng dialog import và clear `pendingFile`.
  - Data: set state trước đó rồi bấm Cancel.
  - Expected: `dialogType=null`, `pendingFile=null`.
- [ ] Edge: `pendingFile` đã null.
  - Data: cancel khi chưa chọn file.
  - Expected: state không lỗi.
- [ ] Error: không có error path nội tại.

### Inline callback `onCancel={() => setDialogType(null)}` của export dialog
- [ ] Happy: đóng dialog export.
  - Data: mở dialog export rồi click Cancel.
  - Expected: `dialogType=null`.
- [ ] Edge: cancel khi dialog đã đóng.
  - Data: gọi callback khi state hiện tại `null`.
  - Expected: không thay đổi state ngoài ý muốn.
- [ ] Error: không có error path nội tại.

## `src/components/PasswordDialog.tsx`

### `PasswordDialog(props)`
- [ ] Happy: `isOpen=false` trả `null`.
  - Data: render với `isOpen=false`.
  - Expected: không có DOM node dialog.
- [ ] Happy: `isOpen=true` render đủ title/description/input/button.
  - Data: `title='Encrypt Cookies'`, `description='...'`.
  - Expected: visible, input `autoFocus`.
- [ ] Edge: mở/đóng liên tục.
  - Data: toggle prop `isOpen`.
  - Expected: không crash, trạng thái input đúng theo hành vi mong muốn.
- [ ] Error: props callback throw (`onConfirm`, `onCancel`).
  - Data: callback mock throw.
  - Expected: test ghi nhận hành vi bubble error.

### `handleSubmit(e)`
- [ ] Happy: password hợp lệ gọi `onConfirm(password)` và clear input.
  - Data: nhập `passwordStrong`, submit form.
  - Expected: `onConfirm` được gọi 1 lần với đúng string.
- [ ] Edge: password chỉ khoảng trắng.
  - Data: `'   '`.
  - Expected: không gọi `onConfirm`, nút Confirm disabled.
- [ ] Edge: password có leading/trailing spaces.
  - Data: `'  abc123  '`.
  - Expected: pass điều kiện `trim()`, callback nhận raw value hiện tại.
- [ ] Error: `onConfirm` throw.
  - Data: mock `onConfirm` throw.
  - Expected: submit throw; test xác nhận cần harden nếu muốn giữ UI ổn định.

### Inline callback `onChange={(e) => setPassword(e.target.value)}`
- [ ] Happy: gõ ký tự cập nhật state, enable Confirm.
  - Data: nhập `abc`.
  - Expected: value input đổi, button enabled.
- [ ] Edge: input rất dài (>=2048 chars).
  - Data: `'x'.repeat(2048)`.
  - Expected: vẫn cập nhật được.
- [ ] Error: event malformed (không có `target.value`).
  - Data: fire synthetic event lỗi.
  - Expected: test fail rõ nguyên nhân (để harden nếu cần).

### Inline callback toggle show password (`onClick={() => setShowPassword(!showPassword)}`)
- [ ] Happy: click toggle `password` <-> `text`.
  - Data: click icon 2 lần.
  - Expected: type input đổi qua lại đúng.
- [ ] Edge: toggle nhanh nhiều lần.
  - Data: click liên tục.
  - Expected: trạng thái cuối cùng đúng theo parity số lần click.
- [ ] Error: không có error path nội tại.

## Coverage Gaps Hiện Tại (so với test đang có)

- `tests/crypto.test.ts` và `tests/background.test.ts` mới cover một phần `crypto/background`.
- Chưa có file test cho `src/App.tsx` và `src/components/PasswordDialog.tsx`.
- Chưa có case lỗi sâu cho:
  - throw từ browser APIs (`chrome.tabs`, `chrome.cookies`, `URL.createObjectURL`, `document.createElement`),
  - tamper encrypted payload,
  - negative/oversized length trong `generatePassword`.
