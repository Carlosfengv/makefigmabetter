# ADR 0017：Protocol Buffers 作为服务端契约

状态：已采纳（Phase 1.2）

浏览器、Document Service 和未来 Gateway 通过 `schemas/proto/editor/v1/editor.proto` 交换 `OperationEnvelope`、`DocumentSnapshot`、`OperationAck`、`ProtocolError` 和版本协商消息。Rust 类型由 `crates/protocol` 的 `prost-build` 生成，TypeScript 类型由 `ts-proto` 生成至 `packages/protocol-types`；应用与服务不得复制这些 wire DTO。

字段号只可追加。删除的字段必须 `reserved`，需要区分未设置与默认值的标量使用 `optional`。Canonical Hash、payload hash 和 asset hash 依据各自的规范化语义状态计算，禁止把 Protobuf 编码字节作为 Hash 输入。

不了解业务 payload 的 Gateway、队列和日志组件必须使用 `OpaqueOperationEnvelope` 原样转发 bytes，不能 decode/re-encode；当前 Rust Protobuf runtime 会跳过 unknown field，重编码会丢失它们。版本协商不兼容时返回 `ProtocolError`，而不是回退到未版本化 JSON。
