# Test checklist (PAT-22/PAT-23)

## `src/lib/crypto.ts`

- [x] `encrypt` + `decrypt` round-trip với payload JSON + unicode.
- [x] `encrypt` trả metadata hợp lệ (`data`, `iv`, `salt`), kiểm tra độ dài IV/salt.
- [x] `decrypt` sai password phải throw error.
- [x] Cùng input/password nhưng nhiều lần `encrypt` phải tạo output khác nhau (salt/iv ngẫu nhiên).
- [x] `generatePassword` custom length + tập ký tự hợp lệ.
- [x] `generatePassword` default length và edge case `length = 0`.

## `src/background.ts`

- [x] Đăng ký listener cho `chrome.runtime.onInstalled` khi module load.
- [x] Đăng ký listener cho `chrome.runtime.onMessage` khi module load.
- [x] `onInstalled` log thông báo cài đặt.
- [x] `onMessage` phản hồi `{ success: true }` và trả `true` để giữ message channel.

## Coverage còn thiếu

- [ ] `src/App.tsx` flow UI end-to-end với `chrome.cookies`, download/upload file.
- [ ] `src/components/PasswordDialog.tsx` tương tác form/validation ở môi trường DOM.
