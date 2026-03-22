# pilot-001 checklist

## 导出前检查

- [ ] 已确认批次为 `pilot-001`
- [ ] 已确认来源工作表为 `① 流水明细`
- [ ] 已确认选择行号为 `3` 到 `12`
- [ ] 已确认对应 voucher 范围一并纳入
- [ ] 已确认不导出批次外数据

## 导入前检查

- [ ] `export.json` 已生成
- [ ] 已执行 `validate-export.js`
- [ ] `checksum / transactions / vouchers` 结构存在
- [ ] `totalRows` 与 `transactions.length` 一致
- [ ] `totalVoucherFiles` 与 `vouchers.length` 一致
- [ ] `legacyDriveId` 无重复

## 图片迁移前检查

- [ ] `transactions` 已导入
- [ ] `vouchers` 元数据已导入
- [ ] 本批次 voucher 范围已确认
- [ ] 只处理 `pending / failed`
- [ ] `done` 不重复上传

## 回填前检查

- [ ] 图片迁移结果已落到 `vouchers`
- [ ] `done / failed / pending` 已统计
- [ ] 只回填 `done`
- [ ] `voucherIds` 原始顺序可用
- [ ] 回填只补缺失项

## 验收前检查

- [ ] 本批次 `transactions` 可查询
- [ ] 本批次 `vouchers` 可查询
- [ ] 图片迁移结果可查询
- [ ] 关联字段已回填
- [ ] 已准备《最终验收核对表》
