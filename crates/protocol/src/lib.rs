//! Generated protobuf contract shared by browser clients and document services.
//!
//! The generated messages are a wire boundary only. Canonical hashes are computed
//! by the document core, never from protobuf byte representation.

pub const PROTOCOL_VERSION: u32 = 1;

pub mod v1 {
    include!(concat!(env!("OUT_DIR"), "/makefigma.editor.v1.rs"));
}

/// Preserve bytes when a gateway or queue only needs to forward an envelope.
/// Decoding and re-encoding protobuf in that path would discard unknown fields in
/// the Rust runtime, violating the forward-compatible transport contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueOperationEnvelope(pub Vec<u8>);

impl OpaqueOperationEnvelope {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

pub fn negotiate_protocol(requested: u32) -> Result<u32, v1::ProtocolError> {
    if requested == PROTOCOL_VERSION {
        return Ok(PROTOCOL_VERSION);
    }
    Err(v1::ProtocolError {
        code: v1::ErrorCode::ProtocolVersionUnsupported as i32,
        safe_message: "Unsupported protocol version.".into(),
        supported_protocol_versions: Some(v1::VersionRange {
            min_protocol_version: PROTOCOL_VERSION,
            max_protocol_version: PROTOCOL_VERSION,
        }),
        minimum_engine_semantics_version: None,
        details: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use prost::Message;

    use super::{OpaqueOperationEnvelope, PROTOCOL_VERSION, negotiate_protocol, v1};

    #[test]
    fn generated_operation_round_trips_without_becoming_a_core_struct() {
        let operation = v1::OperationEnvelope {
            schema_version: 1,
            document_id: vec![1; 16],
            operation_id: vec![2; 16],
            transaction_id: vec![3; 16],
            actor_id: vec![4; 16],
            session_id: vec![5; 16],
            client_sequence: 9,
            base_revision: 7,
            causal_parent_ids: vec![vec![6; 16]],
            payload: vec![42, 9],
            payload_hash: vec![8; 32],
            engine_semantics_version: Some(3),
        };
        let bytes = operation.encode_to_vec();
        assert_eq!(
            v1::OperationEnvelope::decode(bytes.as_slice()).unwrap(),
            operation
        );
        assert_eq!(OpaqueOperationEnvelope(bytes.clone()).as_bytes(), bytes);
    }

    #[test]
    fn opaque_forwarding_retains_an_unknown_future_field() {
        let operation = v1::OperationEnvelope {
            schema_version: 1,
            document_id: vec![1; 16],
            operation_id: vec![2; 16],
            transaction_id: vec![3; 16],
            actor_id: vec![4; 16],
            session_id: vec![5; 16],
            client_sequence: 0,
            base_revision: 0,
            causal_parent_ids: vec![],
            payload: vec![],
            payload_hash: vec![],
            engine_semantics_version: None,
        };
        let mut future_bytes = operation.encode_to_vec();
        // field 99, varint wire type, value 1. Current generated types do not know it.
        future_bytes.extend([0x98, 0x06, 0x01]);
        assert_eq!(
            OpaqueOperationEnvelope(future_bytes.clone()).as_bytes(),
            future_bytes
        );
        // A decoder may inspect known fields, but it must not be used to forward.
        assert_eq!(
            v1::OperationEnvelope::decode(future_bytes.as_slice()).unwrap(),
            operation
        );
    }

    #[test]
    fn version_negotiation_returns_structured_incompatibility() {
        assert_eq!(negotiate_protocol(PROTOCOL_VERSION), Ok(PROTOCOL_VERSION));
        let error = negotiate_protocol(PROTOCOL_VERSION + 1).unwrap_err();
        assert_eq!(error.code, v1::ErrorCode::ProtocolVersionUnsupported as i32);
        assert_eq!(
            error
                .supported_protocol_versions
                .unwrap()
                .min_protocol_version,
            PROTOCOL_VERSION
        );
    }
}
