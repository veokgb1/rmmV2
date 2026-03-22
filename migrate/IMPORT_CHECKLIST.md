# 真实导入前 Checklist

这份清单用于在执行非 `DRY_RUN` 导入前做人工确认。

---

## 一、必须准备（否则无法运行）

- [ ] `migrate/export.json` 已存在，并且是本次要导入的最终版本
- [ ] `migrate/serviceAccount.json` 已存在，并且是可用的 Firebase 服务账号文件
- [ ] 环境变量 `FIREBASE_STORAGE_BUCKET` 已配置
- [ ] 本地 Node.js 环境可用，能够正常运行 `node migrate/import.js`

---

## 二、强烈建议确认（否则可能出错）

- [ ] `export.json` 的行数正确，确认本次导入范围就是预期范围
- [ ] `transactions[*].voucherIds` 没有缺失、格式异常或明显重复
- [ ] `checksum.totalAmount` 合理，或至少与导出数据金额汇总一致
- [ ] 旧系统对应的 Drive 文件仍然存在，并且当前账号具备读取权限
- [ ] 目标 Firestore 集合路径已经确认
说明：当前脚本会写入 `transactions` 和 `vouchers`

---

## 三、执行前最终确认

- [ ] 已明确关闭 `DRY_RUN`
- [ ] 已确认允许写入 Firestore
- [ ] 已确认允许上传到 Firebase Storage
- [ ] 当前是小批量测试，不是全量迁移
- [ ] 原始数据已经备份，出现问题时可回溯

---

## 执行命令示例

DRY_RUN 命令：

```powershell
cd E:\rmm-2sys\rmm-workspace\2.V2rmm
$env:DRY_RUN='1'; node migrate/import.js
```

preflight-only 命令：

```powershell
cd E:\rmm-2sys\rmm-workspace\2.V2rmm
$env:PREFLIGHT_ONLY='1'; $env:DRY_RUN='1'; node migrate/import.js
```

真实导入命令（慎用）：

```powershell
cd E:\rmm-2sys\rmm-workspace\2.V2rmm
$env:FIREBASE_STORAGE_BUCKET='your-bucket.appspot.com'; node migrate/import.js
```
