# pilot-001 执行说明

## 本批次样本范围

- 老系统工作表：`① 流水明细`
- 样本行范围：第 `3` 行到第 `12` 行
- 本批次共 `10` 条 transaction 样本

## 本批次目标

- 打通 `pilot-001` 主迁移流程
- 验证 `export.json` 结构可用
- 验证 `transactions` 导入流程可用
- 验证 `vouchers` 元数据导入流程可用
- 验证图片迁移流程可用
- 验证关联回填流程可用
- 最后按《最终验收核对表》完成验收

## 执行顺序

1. 导出 `export.json`
2. 导入 `transactions`
3. 导入 `vouchers` 元数据
4. 图片迁移
5. 关联回填
6. 按《最终验收核对表》验收

## 第 1 步：导出 export.json

### 输入

- 老系统 `① 流水明细`
- 行号范围 `3` 到 `12`
- 这些行对应的凭证引用信息

### 输出

- `export.json`

### 中断点

- `export.json` 导出完成后可中断

### 回滚点

- 不涉及新系统写入
- 重新导出即可

## 第 2 步：导入 transactions

### 输入

- `export.json.transactions`

### 输出

- Firestore `transactions` 文档

### 中断点

- `transactions` 导入完成后可中断

### 回滚点

- 仅删除本批次 `pilot-001` 新增的 `transactions` 文档

## 第 3 步：导入 vouchers 元数据

### 输入

- `export.json.vouchers`

### 输出

- Firestore `vouchers` 文档

### 中断点

- `vouchers` 元数据导入完成后可中断

### 回滚点

- 仅删除本批次 `pilot-001` 新增的 `vouchers` 文档
- 如需整批回滚，再删除本批次 `transactions`

## 第 4 步：图片迁移

### 输入

- Firestore `vouchers`
- 每条 voucher 的 `legacyDriveId`

### 输出

- Firebase Storage 图片文件
- 更新后的 `vouchers` 迁移状态

### 中断点

- 每迁移完一张图片可中断
- 整批图片迁移完成后可中断

### 回滚点

- 暂停继续：保留已完成图片，仅补 `failed / pending`
- 整批回滚：删除本批次已上传图片，再删除本批次 `vouchers` 和 `transactions`

## 第 5 步：关联回填

### 输入

- Firestore `transactions`
- Firestore `vouchers`
- 已成功迁移图片的 Storage 结果

### 输出

- `transactions.voucherRefIds`
- `transactions.voucherStoragePaths`
- `vouchers.linkedTransactionIds`

### 中断点

- 回填完一条 transaction 可中断
- 回填完一条 voucher 可中断
- 整批回填完成后可中断

### 回滚点

- 只清理本批次新增的关联字段
- 不删除已确认无误的交易主数据
- 不删除已确认无误的图片文件

## 第 6 步：按《最终验收核对表》验收

### 输入

- `export.json`
- Firestore `transactions`
- Firestore `vouchers`
- Firebase Storage 图片文件
- 《最终验收核对表》

### 输出

- `pilot-001` 验收结果

### 中断点

- 任一核对项发现异常可中断

### 回滚点

- 按异常所在阶段回滚
- 优先局部回滚，不直接整批回滚
