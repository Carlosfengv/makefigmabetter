//! Canonical document and transaction primitives shared by browser and server runtimes.
//!
//! The crate deliberately contains no rendering cache, UI state, or transport types.
//! A document is the only source of truth; consumers derive scene and GPU state after a
//! transaction has been accepted.

pub mod color;
pub mod authz;
pub mod geometry;

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use sha2::{Digest, Sha256};
use crate::color::{Color, ColorSpace, DocumentColorProfile, Paint};

pub const MAX_TRANSACTION_COMMANDS: usize = 10_000;
pub const MAX_TRANSACTION_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_HISTORY_ITEMS: usize = 256;
pub const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DEDUPE_ITEMS: usize = 4_096;
pub const MAX_DEDUPE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_OPERATION_DEDUPE_ITEMS: usize = 4_096;
pub const MAX_OPERATION_DEDUPE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_DOCUMENT_NODES: usize = 100_000;
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 1 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DocumentId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActorId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OperationId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub u128);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TransactionId(pub u128);

/// A stable sibling-order key. `key` provides a dense local ordering space while
/// `actor` deterministically breaks concurrent allocations at the same midpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PositionId {
    pub key: u128,
    pub actor: ActorId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionError {
    NoSpaceBetween,
}

impl PositionId {
    pub fn for_node(id: NodeId) -> Self {
        Self { key: id.0, actor: ActorId(0) }
    }

    pub fn between(left: Option<Self>, right: Option<Self>, actor: ActorId) -> Result<Self, PositionError> {
        let lower = left.map(|position| position.key).unwrap_or(0);
        let upper = right.map(|position| position.key).unwrap_or(u128::MAX);
        if lower >= upper.saturating_sub(1) {
            return Err(PositionError::NoSpaceBetween);
        }
        Ok(Self { key: lower + (upper - lower) / 2, actor })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Frame,
    Rectangle,
    Ellipse,
    Text,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub id: NodeId,
    pub parent_id: Option<NodeId>,
    /// Canonical sibling order. Parent/position pairs, rather than UI array order,
    /// determine traversal and future concurrent child insertion.
    pub position: PositionId,
    pub name: String,
    pub kind: NodeKind,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    /// Explicit non-premultiplied document color; CSS is only a projection detail.
    pub fill: Paint,
    /// Canonical stroke paint. Rendering projections may choose a CSS fallback,
    /// but stroke semantics belong to the document just like fill semantics.
    pub stroke: Paint,
    pub stroke_width: f64,
    pub opacity: f64,
    pub corner_radius: f64,
    /// Canonical plain text. Rich style runs and shaping belong to the future text engine.
    pub text: String,
    pub visible: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    id: DocumentId,
    pub revision: u64,
    color_profile: DocumentColorProfile,
    nodes: BTreeMap<NodeId, Node>,
    node_bytes: usize,
    /// IDs are never allocated to an unrelated new node after deletion.
    retired_ids: BTreeSet<NodeId>,
    undo_stack: Vec<HistoryItem>,
    redo_stack: Vec<HistoryItem>,
    undo_bytes: usize,
    redo_bytes: usize,
    /// Dedupe state belongs to the canonical document: retrying an already accepted
    /// transaction must not create a second revision or history item.
    accepted_transactions: BTreeMap<TransactionId, AcceptedTransactionRecord>,
    accepted_transaction_order: VecDeque<TransactionId>,
    accepted_transaction_bytes: usize,
    /// Operation delivery is at-least-once. This independent cache ensures a reused
    /// operation ID cannot either mutate twice or silently carry a different payload.
    accepted_operations: BTreeMap<OperationId, AcceptedOperationRecord>,
    accepted_operation_order: VecDeque<OperationId>,
    accepted_operation_bytes: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct AcceptedTransactionRecord {
    transaction: Transaction,
    applied: AppliedTransaction,
}

#[derive(Debug, Clone, PartialEq)]
struct AcceptedOperationRecord {
    fingerprint: [u8; 32],
    applied: AppliedOperation,
    estimated_bytes: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Create(Node),
    UpdateGeometry {
        id: NodeId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        rotation: f64,
    },
    Rename {
        id: NodeId,
        name: String,
    },
    SetAppearance {
        id: NodeId,
        appearance: Appearance,
    },
    SetText {
        id: NodeId,
        text: String,
    },
    SetDocumentColorProfile {
        profile: DocumentColorProfile,
    },
    Delete {
        id: NodeId,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Transaction {
    pub id: TransactionId,
    pub base_revision: u64,
    pub commands: Vec<Command>,
}

/// Stable, serializable collaboration boundary. `Transaction` remains a local
/// intent/reducer unit; an Operation contains only resolved, concrete commands.
#[derive(Debug, Clone, PartialEq)]
pub struct OperationEnvelope {
    pub schema_version: u32,
    pub document_id: DocumentId,
    pub operation_id: OperationId,
    pub transaction_id: TransactionId,
    pub actor_id: ActorId,
    pub base_revision: u64,
    pub causal_parents: Vec<OperationId>,
    pub transaction: Transaction,
    pub payload_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    LocalUser,
    RemoteOperation,
    Import,
    SystemRepair,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppliedChange {
    NodeCreated {
        node: Node,
    },
    GeometryChanged {
        id: NodeId,
        before: Geometry,
        after: Geometry,
    },
    NameChanged {
        id: NodeId,
        before: String,
        after: String,
    },
    AppearanceChanged {
        id: NodeId,
        before: Appearance,
        after: Appearance,
    },
    TextChanged {
        id: NodeId,
        before: String,
        after: String,
    },
    DocumentColorProfileChanged {
        before: DocumentColorProfile,
        after: DocumentColorProfile,
    },
    NodeDeleted {
        node: Node,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Appearance {
    pub fill: Paint,
    pub stroke: Paint,
    pub stroke_width: f64,
    pub opacity: f64,
    pub corner_radius: f64,
    pub visible: bool,
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HistoryItem {
    pub transaction_id: TransactionId,
    pub origin: Origin,
    pub base_revision: u64,
    pub accepted_revision: u64,
    pub changes: Vec<AppliedChange>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AppliedTransaction {
    pub transaction_id: TransactionId,
    pub accepted_revision: u64,
    pub history_item: HistoryItem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedOperation {
    pub operation_id: OperationId,
    pub transaction_id: TransactionId,
    pub accepted_revision: u64,
    pub payload_hash: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryStats {
    pub node_count: usize,
    pub node_bytes: usize,
    pub undo_items: usize,
    pub undo_bytes: usize,
    pub redo_items: usize,
    pub redo_bytes: usize,
    pub dedupe_items: usize,
    pub dedupe_bytes: usize,
    pub operation_dedupe_items: usize,
    pub operation_dedupe_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandError {
    RevisionConflict { expected: u64, actual: u64 },
    EmptyTransaction,
    MissingNode { id: NodeId },
    DuplicateNode { id: NodeId },
    RetiredNodeId { id: NodeId },
    InvalidGeometry,
    InvalidName,
    InvalidAppearance,
    InvalidText,
    MissingParent { id: NodeId },
    NodeHasChildren { id: NodeId },
    TransactionIdConflict { id: TransactionId },
    OperationIdConflict { id: OperationId },
    UnsupportedOperationSchema { found: u32 },
    OperationDocumentMismatch { expected: DocumentId, actual: DocumentId },
    OperationTransactionMismatch,
    OperationPayloadHashMismatch,
    ResourceLimit,
    PositionExhausted,
}

impl Document {
    pub fn empty() -> Self {
        Self::with_id(DocumentId(0))
    }

    pub fn with_id(id: DocumentId) -> Self {
        Self {
            id,
            revision: 0,
            color_profile: DocumentColorProfile::Srgb,
            nodes: BTreeMap::new(),
            node_bytes: 0,
            retired_ids: BTreeSet::new(),
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            undo_bytes: 0,
            redo_bytes: 0,
            accepted_transactions: BTreeMap::new(),
            accepted_transaction_order: VecDeque::new(),
            accepted_transaction_bytes: 0,
            accepted_operations: BTreeMap::new(),
            accepted_operation_order: VecDeque::new(),
            accepted_operation_bytes: 0,
        }
    }

    pub fn id(&self) -> DocumentId {
        self.id
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn ordered_nodes(&self) -> Vec<&Node> {
        let mut nodes = self.nodes.values().collect::<Vec<_>>();
        nodes.sort_unstable_by_key(|node| (node.parent_id, node.position, node.id));
        nodes
    }

    pub fn position_between(
        &self,
        parent_id: Option<NodeId>,
        left_id: Option<NodeId>,
        right_id: Option<NodeId>,
        actor: ActorId,
    ) -> Result<PositionId, CommandError> {
        let sibling_position = |id: NodeId| {
            self.nodes
                .get(&id)
                .filter(|node| node.parent_id == parent_id)
                .map(|node| node.position)
                .ok_or(CommandError::MissingNode { id })
        };
        let left = left_id.map(sibling_position).transpose()?;
        let right = right_id.map(sibling_position).transpose()?;
        if let (Some(left), Some(right)) = (left, right) {
            if left >= right {
                return Err(CommandError::PositionExhausted);
            }
        }
        PositionId::between(left, right, actor).map_err(|_| CommandError::PositionExhausted)
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn color_profile(&self) -> DocumentColorProfile {
        self.color_profile
    }

    /// Snapshot hydration is trusted only after the caller verifies its schema and
    /// Canonical hash. It does not create a user-visible history item.
    pub fn seed_color_profile(&mut self, profile: DocumentColorProfile) {
        self.color_profile = profile;
    }

    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }

    pub fn retired_ids(&self) -> impl Iterator<Item = &NodeId> {
        self.retired_ids.iter()
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn memory_stats(&self) -> MemoryStats {
        MemoryStats {
            node_count: self.nodes.len(),
            node_bytes: self.node_bytes,
            undo_items: self.undo_stack.len(),
            undo_bytes: self.undo_bytes,
            redo_items: self.redo_stack.len(),
            redo_bytes: self.redo_bytes,
            dedupe_items: self.accepted_transactions.len(),
            dedupe_bytes: self.accepted_transaction_bytes,
            operation_dedupe_items: self.accepted_operations.len(),
            operation_dedupe_bytes: self.accepted_operation_bytes,
        }
    }

    /// SHA-256 of the canonical semantic state. It deliberately excludes revision,
    /// undo and dedupe caches so different valid delivery paths with the same document
    /// compare equal; retained IDs are included because reuse is an invariant.
    pub fn canonical_hash(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/canonical-v1");
        hash_document_color_profile(&mut hasher, self.color_profile);
        hash_len(&mut hasher, self.nodes.len());
        for node in self.nodes.values() {
            hash_node(&mut hasher, node);
        }
        hash_len(&mut hasher, self.retired_ids.len());
        for id in &self.retired_ids {
            hasher.update(id.0.to_be_bytes());
        }
        hasher.finalize().into()
    }

    pub fn canonical_hash_hex(&self) -> String {
        self.canonical_hash()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// Installs a trusted persisted node while constructing a document projection.
    /// Hydration is not a user edit and therefore does not advance the revision or
    /// enter the local undo history.
    pub fn seed_node(&mut self, node: Node) -> Result<(), CommandError> {
        self.apply(&Command::Create(node)).map(|_| ())
    }

    /// Restores an ID tombstone from a trusted snapshot. A tombstone is semantic
    /// document state: omitting it would let a refresh silently reuse a deleted ID.
    pub fn seed_retired_id(&mut self, id: NodeId) -> Result<(), CommandError> {
        if self.nodes.contains_key(&id) {
            return Err(CommandError::DuplicateNode { id });
        }
        self.retired_ids.insert(id);
        Ok(())
    }

    /// Resolves and applies a user intent atomically. Any rejected command leaves the
    /// document, revision and emitted history untouched.
    pub fn submit(
        &mut self,
        transaction: Transaction,
        origin: Origin,
    ) -> Result<AppliedTransaction, CommandError> {
        if let Some(previous) = self.accepted_transactions.get(&transaction.id) {
            return if previous.transaction == transaction {
                Ok(previous.applied.clone())
            } else {
                Err(CommandError::TransactionIdConflict { id: transaction.id })
            };
        }
        if transaction.base_revision != self.revision {
            return Err(CommandError::RevisionConflict {
                expected: self.revision,
                actual: transaction.base_revision,
            });
        }
        if transaction.commands.is_empty() {
            return Err(CommandError::EmptyTransaction);
        }
        if transaction.commands.len() > MAX_TRANSACTION_COMMANDS || transaction.estimated_bytes() > MAX_TRANSACTION_BYTES {
            return Err(CommandError::ResourceLimit);
        }

        let mut next = self.clone();
        let mut changes = Vec::with_capacity(transaction.commands.len());
        for command in &transaction.commands {
            changes.push(next.apply(command)?);
        }
        next.revision += 1;
        let accepted_revision = next.revision;
        let history_item = HistoryItem {
            transaction_id: transaction.id,
            origin,
            base_revision: transaction.base_revision,
            accepted_revision,
            changes,
        };
        if origin == Origin::LocalUser && history_item.estimated_bytes() > MAX_HISTORY_BYTES {
            return Err(CommandError::ResourceLimit);
        }
        if origin == Origin::LocalUser {
            next.push_undo(history_item.clone());
            next.clear_redo();
        }
        let applied = AppliedTransaction {
            transaction_id: transaction.id,
            accepted_revision,
            history_item,
        };
        next.insert_accepted_transaction(
            transaction.id,
            AcceptedTransactionRecord {
                transaction,
                applied: applied.clone(),
            },
        );
        *self = next;
        Ok(applied)
    }

    /// Applies a resolved collaboration operation through the exact same reducer as
    /// a local transaction. A retry with an identical operation ID is a no-op; a
    /// reused ID with a different envelope is rejected before any mutation.
    pub fn submit_operation(
        &mut self,
        operation: OperationEnvelope,
        origin: Origin,
    ) -> Result<AppliedOperation, CommandError> {
        let operation = operation.canonicalized();
        operation.validate_for(self.id)?;
        let fingerprint = operation.fingerprint();
        if let Some(previous) = self.accepted_operations.get(&operation.operation_id) {
            return if previous.fingerprint == fingerprint {
                Ok(previous.applied.clone())
            } else {
                Err(CommandError::OperationIdConflict {
                    id: operation.operation_id,
                })
            };
        }
        if operation.estimated_bytes() > MAX_OPERATION_DEDUPE_BYTES {
            return Err(CommandError::ResourceLimit);
        }

        let mut next = self.clone();
        let accepted_transaction = next.submit(operation.transaction.clone(), origin)?;
        let applied = AppliedOperation {
            operation_id: operation.operation_id,
            transaction_id: operation.transaction_id,
            accepted_revision: accepted_transaction.accepted_revision,
            payload_hash: operation.payload_hash,
        };
        let operation_bytes = operation.estimated_bytes();
        next.insert_accepted_operation(
            operation.operation_id,
            AcceptedOperationRecord {
                fingerprint,
                applied: applied.clone(),
                estimated_bytes: operation_bytes,
            },
        );
        *self = next;
        Ok(applied)
    }

    /// Replays the inverse of the latest local user intent. Revisions remain monotonic:
    /// undo and redo are new accepted document states, never a rewind of revision.
    pub fn undo(&mut self) -> Option<u64> {
        let item = self.undo_stack.pop()?;
        self.undo_bytes = self.undo_bytes.saturating_sub(item.estimated_bytes());
        for change in item.changes.iter().rev() {
            self.apply_inverse(change);
        }
        self.revision += 1;
        self.push_redo(item);
        Some(self.revision)
    }

    pub fn redo(&mut self) -> Option<u64> {
        let item = self.redo_stack.pop()?;
        self.redo_bytes = self.redo_bytes.saturating_sub(item.estimated_bytes());
        for change in &item.changes {
            self.apply_forward(change);
        }
        self.revision += 1;
        self.push_undo(item);
        Some(self.revision)
    }

    fn clear_redo(&mut self) {
        self.redo_stack.clear();
        self.redo_bytes = 0;
    }

    fn push_undo(&mut self, item: HistoryItem) {
        self.undo_bytes += item.estimated_bytes();
        self.undo_stack.push(item);
        while self.undo_stack.len() > MAX_HISTORY_ITEMS || self.undo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.undo_stack.first() {
                self.undo_bytes = self.undo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.undo_stack.remove(0);
        }
    }

    fn push_redo(&mut self, item: HistoryItem) {
        self.redo_bytes += item.estimated_bytes();
        self.redo_stack.push(item);
        while self.redo_stack.len() > MAX_HISTORY_ITEMS || self.redo_bytes > MAX_HISTORY_BYTES {
            if let Some(discarded) = self.redo_stack.first() {
                self.redo_bytes = self.redo_bytes.saturating_sub(discarded.estimated_bytes());
            }
            self.redo_stack.remove(0);
        }
    }

    fn insert_accepted_transaction(&mut self, id: TransactionId, record: AcceptedTransactionRecord) {
        self.accepted_transaction_bytes += record.estimated_bytes();
        self.accepted_transactions.insert(id, record);
        self.accepted_transaction_order.push_back(id);
        while self.accepted_transactions.len() > MAX_DEDUPE_ITEMS || self.accepted_transaction_bytes > MAX_DEDUPE_BYTES {
            let Some(expired_id) = self.accepted_transaction_order.pop_front() else { break };
            if let Some(expired) = self.accepted_transactions.remove(&expired_id) {
                self.accepted_transaction_bytes = self.accepted_transaction_bytes.saturating_sub(expired.estimated_bytes());
            }
        }
    }

    fn insert_accepted_operation(
        &mut self,
        id: OperationId,
        record: AcceptedOperationRecord,
    ) {
        self.accepted_operation_bytes += record.estimated_bytes;
        self.accepted_operations.insert(id, record);
        self.accepted_operation_order.push_back(id);
        while self.accepted_operations.len() > MAX_OPERATION_DEDUPE_ITEMS
            || self.accepted_operation_bytes > MAX_OPERATION_DEDUPE_BYTES
        {
            let Some(expired_id) = self.accepted_operation_order.pop_front() else {
                break;
            };
            if let Some(expired) = self.accepted_operations.remove(&expired_id) {
                self.accepted_operation_bytes = self
                    .accepted_operation_bytes
                    .saturating_sub(expired.estimated_bytes);
            }
        }
    }

    fn apply(&mut self, command: &Command) -> Result<AppliedChange, CommandError> {
        match command {
            Command::Create(node) => {
                if self.nodes.len() >= MAX_DOCUMENT_NODES {
                    return Err(CommandError::ResourceLimit);
                }
                self.validate_node(node)?;
                if self.node_bytes.saturating_add(node.estimated_bytes()) > MAX_DOCUMENT_BYTES {
                    return Err(CommandError::ResourceLimit);
                }
                if self.nodes.contains_key(&node.id) {
                    return Err(CommandError::DuplicateNode { id: node.id });
                }
                if self.retired_ids.contains(&node.id) {
                    return Err(CommandError::RetiredNodeId { id: node.id });
                }
                self.nodes.insert(node.id, node.clone());
                self.node_bytes += node.estimated_bytes();
                Ok(AppliedChange::NodeCreated { node: node.clone() })
            }
            Command::UpdateGeometry {
                id,
                x,
                y,
                width,
                height,
                rotation,
            } => {
                let after = Geometry {
                    x: *x,
                    y: *y,
                    width: *width,
                    height: *height,
                    rotation: *rotation,
                };
                if !valid_geometry(after) {
                    return Err(CommandError::InvalidGeometry);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before = Geometry {
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    rotation: node.rotation,
                };
                (node.x, node.y, node.width, node.height, node.rotation) =
                    (after.x, after.y, after.width, after.height, after.rotation);
                Ok(AppliedChange::GeometryChanged {
                    id: *id,
                    before,
                    after,
                })
            }
            Command::Rename { id, name } => {
                if name.trim().is_empty() {
                    return Err(CommandError::InvalidName);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes - node.name.len() + name.len();
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = std::mem::replace(&mut node.name, name.clone());
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                Ok(AppliedChange::NameChanged {
                    id: *id,
                    before,
                    after: name.clone(),
                })
            }
            Command::SetAppearance { id, appearance } => {
                if !valid_appearance(appearance) {
                    return Err(CommandError::InvalidAppearance);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes
                    .saturating_sub(node.fill.estimated_bytes())
                    .saturating_sub(node.stroke.estimated_bytes())
                    .saturating_add(appearance.fill.estimated_bytes())
                    .saturating_add(appearance.stroke.estimated_bytes());
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = Appearance {
                    fill: node.fill.clone(),
                    stroke: node.stroke.clone(),
                    stroke_width: node.stroke_width,
                    opacity: node.opacity,
                    corner_radius: node.corner_radius,
                    visible: node.visible,
                    locked: node.locked,
                };
                node.fill = appearance.fill.clone();
                node.stroke = appearance.stroke.clone();
                node.stroke_width = appearance.stroke_width;
                node.opacity = appearance.opacity;
                node.corner_radius = appearance.corner_radius;
                node.visible = appearance.visible;
                node.locked = appearance.locked;
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                Ok(AppliedChange::AppearanceChanged {
                    id: *id,
                    before,
                    after: appearance.clone(),
                })
            }
            Command::SetText { id, text } => {
                if text.len() > MAX_TEXT_BYTES {
                    return Err(CommandError::InvalidText);
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                if node.kind != NodeKind::Text {
                    return Err(CommandError::InvalidText);
                }
                let before_bytes = node.estimated_bytes();
                let after_bytes = before_bytes - node.text.len() + text.len();
                if self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes)
                    > MAX_DOCUMENT_BYTES
                {
                    return Err(CommandError::ResourceLimit);
                }
                let before = std::mem::replace(&mut node.text, text.clone());
                self.node_bytes = self
                    .node_bytes
                    .saturating_sub(before_bytes)
                    .saturating_add(after_bytes);
                Ok(AppliedChange::TextChanged {
                    id: *id,
                    before,
                    after: text.clone(),
                })
            }
            Command::Delete { id } => {
                if self.nodes.values().any(|node| node.parent_id == Some(*id)) {
                    return Err(CommandError::NodeHasChildren { id: *id });
                }
                let node = self
                    .nodes
                    .remove(id)
                    .ok_or(CommandError::MissingNode { id: *id })?;
                self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
                self.retired_ids.insert(*id);
                Ok(AppliedChange::NodeDeleted { node })
            }
            Command::SetDocumentColorProfile { profile } => {
                let before = self.color_profile;
                self.color_profile = *profile;
                Ok(AppliedChange::DocumentColorProfileChanged {
                    before,
                    after: *profile,
                })
            }
        }
    }

    fn apply_inverse(&mut self, change: &AppliedChange) {
        match change {
            AppliedChange::NodeCreated { node } => self.retire_node(node.id),
            AppliedChange::GeometryChanged { id, before, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    (node.x, node.y, node.width, node.height, node.rotation) =
                        (before.x, before.y, before.width, before.height, before.rotation);
                }
            }
            AppliedChange::NameChanged { id, before, .. } => self.set_name(*id, before),
            AppliedChange::AppearanceChanged { id, before, .. } => self.set_appearance(*id, before),
            AppliedChange::TextChanged { id, before, .. } => self.set_text(*id, before),
            AppliedChange::DocumentColorProfileChanged { before, .. } => self.color_profile = *before,
            AppliedChange::NodeDeleted { node } => self.restore_node(node),
        }
    }

    fn apply_forward(&mut self, change: &AppliedChange) {
        match change {
            AppliedChange::NodeCreated { node } => self.restore_node(node),
            AppliedChange::GeometryChanged { id, after, .. } => {
                if let Some(node) = self.nodes.get_mut(id) {
                    (node.x, node.y, node.width, node.height, node.rotation) =
                        (after.x, after.y, after.width, after.height, after.rotation);
                }
            }
            AppliedChange::NameChanged { id, after, .. } => self.set_name(*id, after),
            AppliedChange::AppearanceChanged { id, after, .. } => self.set_appearance(*id, after),
            AppliedChange::TextChanged { id, after, .. } => self.set_text(*id, after),
            AppliedChange::DocumentColorProfileChanged { after, .. } => self.color_profile = *after,
            AppliedChange::NodeDeleted { node } => self.retire_node(node.id),
        }
    }

    fn set_appearance(&mut self, id: NodeId, appearance: &Appearance) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes
                .saturating_sub(node.fill.estimated_bytes())
                .saturating_sub(node.stroke.estimated_bytes())
                .saturating_add(appearance.fill.estimated_bytes())
                .saturating_add(appearance.stroke.estimated_bytes());
            node.fill = appearance.fill.clone();
            node.stroke = appearance.stroke.clone();
            node.stroke_width = appearance.stroke_width;
            node.opacity = appearance.opacity;
            node.corner_radius = appearance.corner_radius;
            node.visible = appearance.visible;
            node.locked = appearance.locked;
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn set_name(&mut self, id: NodeId, name: &str) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes - node.name.len() + name.len();
            node.name = name.into();
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn set_text(&mut self, id: NodeId, text: &str) {
        if let Some(node) = self.nodes.get_mut(&id) {
            let before_bytes = node.estimated_bytes();
            let after_bytes = before_bytes - node.text.len() + text.len();
            node.text = text.into();
            self.node_bytes = self
                .node_bytes
                .saturating_sub(before_bytes)
                .saturating_add(after_bytes);
        }
    }

    fn retire_node(&mut self, id: NodeId) {
        if let Some(node) = self.nodes.remove(&id) {
            self.node_bytes = self.node_bytes.saturating_sub(node.estimated_bytes());
        }
        self.retired_ids.insert(id);
    }

    fn restore_node(&mut self, node: &Node) {
        self.nodes.insert(node.id, node.clone());
        self.node_bytes += node.estimated_bytes();
        self.retired_ids.remove(&node.id);
    }

    fn validate_node(&self, node: &Node) -> Result<(), CommandError> {
        if node.name.trim().is_empty() {
            return Err(CommandError::InvalidName);
        }
        if !valid_geometry(Geometry {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
        })
        {
            return Err(CommandError::InvalidGeometry);
        }
        if !valid_appearance(&Appearance {
            fill: node.fill.clone(),
            stroke: node.stroke.clone(),
            stroke_width: node.stroke_width,
            opacity: node.opacity,
            corner_radius: node.corner_radius,
            visible: node.visible,
            locked: node.locked,
        }) {
            return Err(CommandError::InvalidAppearance);
        }
        if node.text.len() > MAX_TEXT_BYTES || (node.kind != NodeKind::Text && !node.text.is_empty()) {
            return Err(CommandError::InvalidText);
        }
        if let Some(parent_id) = node.parent_id {
            if !self.nodes.contains_key(&parent_id) {
                return Err(CommandError::MissingParent { id: parent_id });
            }
        }
        Ok(())
    }
}

impl Transaction {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<TransactionId>() + std::mem::size_of::<u64>()
            + self.commands.iter().map(Command::estimated_bytes).sum::<usize>()
    }
}

impl OperationEnvelope {
    pub const SCHEMA_VERSION: u32 = 1;

    pub fn new(
        document_id: DocumentId,
        operation_id: OperationId,
        actor_id: ActorId,
        causal_parents: Vec<OperationId>,
        transaction: Transaction,
    ) -> Self {
        let payload_hash = Self::payload_hash_for(&transaction);
        Self {
            schema_version: Self::SCHEMA_VERSION,
            document_id,
            operation_id,
            transaction_id: transaction.id,
            actor_id,
            base_revision: transaction.base_revision,
            causal_parents,
            transaction,
            payload_hash,
        }
        .canonicalized()
    }

    pub fn payload_hash_for(transaction: &Transaction) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/operation-payload-v1");
        hash_len(&mut hasher, transaction.commands.len());
        for command in &transaction.commands {
            hash_command(&mut hasher, command);
        }
        hasher.finalize().into()
    }

    fn canonicalized(mut self) -> Self {
        self.causal_parents.sort_unstable();
        self.causal_parents.dedup();
        self
    }

    fn validate_for(&self, document_id: DocumentId) -> Result<(), CommandError> {
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err(CommandError::UnsupportedOperationSchema {
                found: self.schema_version,
            });
        }
        if self.document_id != document_id {
            return Err(CommandError::OperationDocumentMismatch {
                expected: document_id,
                actual: self.document_id,
            });
        }
        if self.transaction_id != self.transaction.id
            || self.base_revision != self.transaction.base_revision
        {
            return Err(CommandError::OperationTransactionMismatch);
        }
        if self.payload_hash != Self::payload_hash_for(&self.transaction) {
            return Err(CommandError::OperationPayloadHashMismatch);
        }
        Ok(())
    }

    fn fingerprint(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"makefigma/editor-core/operation-envelope-v1");
        hasher.update(self.schema_version.to_be_bytes());
        hasher.update(self.document_id.0.to_be_bytes());
        hasher.update(self.operation_id.0.to_be_bytes());
        hasher.update(self.transaction_id.0.to_be_bytes());
        hasher.update(self.actor_id.0.to_be_bytes());
        hasher.update(self.base_revision.to_be_bytes());
        hash_len(&mut hasher, self.causal_parents.len());
        for parent in &self.causal_parents {
            hasher.update(parent.0.to_be_bytes());
        }
        hasher.update(self.payload_hash);
        hasher.finalize().into()
    }

    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.causal_parents.len() * std::mem::size_of::<OperationId>()
            + self.transaction.estimated_bytes()
    }
}

impl Command {
    fn estimated_bytes(&self) -> usize {
        match self {
            Command::Create(node) => node.estimated_bytes(),
            Command::UpdateGeometry { .. } => std::mem::size_of::<Geometry>() + std::mem::size_of::<NodeId>(),
            Command::Rename { name, .. } => std::mem::size_of::<NodeId>() + name.len(),
            Command::SetAppearance { appearance, .. } => std::mem::size_of::<NodeId>() + appearance.estimated_bytes(),
            Command::SetText { text, .. } => std::mem::size_of::<NodeId>() + text.len(),
            Command::SetDocumentColorProfile { .. } => std::mem::size_of::<DocumentColorProfile>(),
            Command::Delete { .. } => std::mem::size_of::<NodeId>(),
        }
    }
}

impl Node {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Node>() + self.name.len() + self.text.len() + self.fill.estimated_bytes() + self.stroke.estimated_bytes()
    }
}

impl Appearance {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<Appearance>() + self.fill.estimated_bytes() + self.stroke.estimated_bytes()
    }
}

impl AppliedChange {
    fn estimated_bytes(&self) -> usize {
        match self {
            AppliedChange::NodeCreated { node } | AppliedChange::NodeDeleted { node } => node.estimated_bytes(),
            AppliedChange::GeometryChanged { .. } => std::mem::size_of::<Geometry>() * 2 + std::mem::size_of::<NodeId>(),
            AppliedChange::NameChanged { before, after, .. } => std::mem::size_of::<NodeId>() + before.len() + after.len(),
            AppliedChange::AppearanceChanged { before, after, .. } => std::mem::size_of::<NodeId>() + before.estimated_bytes() + after.estimated_bytes(),
            AppliedChange::TextChanged { before, after, .. } => std::mem::size_of::<NodeId>() + before.len() + after.len(),
            AppliedChange::DocumentColorProfileChanged { .. } => std::mem::size_of::<DocumentColorProfile>() * 2,
        }
    }
}

impl HistoryItem {
    fn estimated_bytes(&self) -> usize {
        std::mem::size_of::<HistoryItem>() + self.changes.iter().map(AppliedChange::estimated_bytes).sum::<usize>()
    }
}

impl AcceptedTransactionRecord {
    fn estimated_bytes(&self) -> usize {
        self.transaction.estimated_bytes() + self.applied.history_item.estimated_bytes()
    }
}

fn hash_len(hasher: &mut Sha256, length: usize) {
    hasher.update((length as u64).to_be_bytes());
}

fn hash_text(hasher: &mut Sha256, value: &str) {
    hash_len(hasher, value.len());
    hasher.update(value.as_bytes());
}

fn hash_number(hasher: &mut Sha256, value: f64) {
    // Document validation rules rule out NaN/Infinity. Normalizing signed zero keeps
    // a harmless transport representation detail from splitting canonical hashes.
    hasher.update((if value == 0.0 { 0.0 } else { value }).to_bits().to_be_bytes());
}

fn hash_color(hasher: &mut Sha256, color: Color) {
    hasher.update([match color.space {
        ColorSpace::Srgb => 0,
        ColorSpace::DisplayP3 => 1,
        ColorSpace::LinearSrgb => 2,
    }]);
    for component in color.components {
        hasher.update((if component == 0.0 { 0.0 } else { component }).to_bits().to_be_bytes());
    }
    hasher.update((if color.alpha == 0.0 { 0.0 } else { color.alpha }).to_bits().to_be_bytes());
}

fn hash_paint(hasher: &mut Sha256, paint: &Paint) {
    match paint {
        Paint::Solid(color) => {
            hasher.update([0]);
            hash_color(hasher, *color);
        }
        Paint::LinearGradient(gradient) => {
            hasher.update([1]);
            for value in gradient.start.into_iter().chain(gradient.end) {
                hasher.update((if value == 0.0 { 0.0 } else { value }).to_bits().to_be_bytes());
            }
            hash_len(hasher, gradient.stops.len());
            for stop in &gradient.stops {
                hasher.update((if stop.position == 0.0 { 0.0 } else { stop.position }).to_bits().to_be_bytes());
                hash_color(hasher, stop.color);
            }
        }
    }
}

fn hash_document_color_profile(hasher: &mut Sha256, profile: DocumentColorProfile) {
    hasher.update([match profile {
        DocumentColorProfile::Srgb => 0,
        DocumentColorProfile::DisplayP3 => 1,
    }]);
}

fn hash_node(hasher: &mut Sha256, node: &Node) {
    hasher.update(node.id.0.to_be_bytes());
    match node.parent_id {
        Some(parent_id) => {
            hasher.update([1]);
            hasher.update(parent_id.0.to_be_bytes());
        }
        None => hasher.update([0]),
    }
    hasher.update(node.position.key.to_be_bytes());
    hasher.update(node.position.actor.0.to_be_bytes());
    hash_text(hasher, &node.name);
    hasher.update([match node.kind {
        NodeKind::Frame => 0,
        NodeKind::Rectangle => 1,
        NodeKind::Ellipse => 2,
        NodeKind::Text => 3,
    }]);
    for value in [node.x, node.y, node.width, node.height, node.rotation, node.stroke_width, node.opacity, node.corner_radius] {
        hash_number(hasher, value);
    }
    hash_paint(hasher, &node.fill);
    hash_paint(hasher, &node.stroke);
    hash_text(hasher, &node.text);
    hasher.update([u8::from(node.visible), u8::from(node.locked)]);
}

fn hash_command(hasher: &mut Sha256, command: &Command) {
    match command {
        Command::Create(node) => {
            hasher.update([0]);
            hash_node(hasher, node);
        }
        Command::UpdateGeometry {
            id,
            x,
            y,
            width,
            height,
            rotation,
        } => {
            hasher.update([1]);
            hasher.update(id.0.to_be_bytes());
            for value in [*x, *y, *width, *height, *rotation] {
                hash_number(hasher, value);
            }
        }
        Command::Rename { id, name } => {
            hasher.update([2]);
            hasher.update(id.0.to_be_bytes());
            hash_text(hasher, name);
        }
        Command::SetAppearance { id, appearance } => {
            hasher.update([3]);
            hasher.update(id.0.to_be_bytes());
            hash_paint(hasher, &appearance.fill);
            hash_paint(hasher, &appearance.stroke);
            hash_number(hasher, appearance.stroke_width);
            hash_number(hasher, appearance.opacity);
            hash_number(hasher, appearance.corner_radius);
            hasher.update([u8::from(appearance.visible), u8::from(appearance.locked)]);
        }
        Command::SetText { id, text } => {
            hasher.update([4]);
            hasher.update(id.0.to_be_bytes());
            hash_text(hasher, text);
        }
        Command::SetDocumentColorProfile { profile } => {
            hasher.update([5]);
            hash_document_color_profile(hasher, *profile);
        }
        Command::Delete { id } => {
            hasher.update([6]);
            hasher.update(id.0.to_be_bytes());
        }
    }
}

fn valid_geometry(geometry: Geometry) -> bool {
    geometry.x.is_finite()
        && geometry.y.is_finite()
        && geometry.width.is_finite()
        && geometry.height.is_finite()
        && geometry.rotation.is_finite()
        && geometry.width > 0.0
        && geometry.height > 0.0
}

fn valid_appearance(appearance: &Appearance) -> bool {
    appearance.fill.is_valid()
        && appearance.stroke.is_valid()
        && appearance.stroke_width.is_finite()
        && appearance.stroke_width >= 0.0
        && appearance.opacity.is_finite()
        && (0.0..=1.0).contains(&appearance.opacity)
        && appearance.corner_radius.is_finite()
        && appearance.corner_radius >= 0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u128) -> Node {
        Node {
            id: NodeId(id),
            parent_id: None,
            position: PositionId::for_node(NodeId(id)),
            name: "Card".into(),
            kind: NodeKind::Frame,
            x: 0.0,
            y: 0.0,
            width: 240.0,
            height: 160.0,
            rotation: 0.0,
            fill: "#fff".into(),
            stroke: "#00000000".into(),
            stroke_width: 0.0,
            opacity: 1.0,
            corner_radius: 0.0,
            text: String::new(),
            visible: true,
            locked: false,
        }
    }

    fn transaction(base_revision: u64, commands: Vec<Command>) -> Transaction {
        Transaction {
            id: TransactionId(base_revision as u128 + 7),
            base_revision,
            commands,
        }
    }

    #[test]
    fn transaction_is_atomic() {
        let mut document = Document::empty();
        let result = document.submit(
            transaction(
                0,
                vec![Command::Create(node(1)), Command::Delete { id: NodeId(2) }],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::MissingNode { id: NodeId(2) }));
        assert_eq!(document.nodes().count(), 0);
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn transaction_emits_history_with_before_and_after_values() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let applied = document
            .submit(
                transaction(
                    1,
                    vec![Command::UpdateGeometry {
                        id: NodeId(1),
                        x: 10.0,
                        y: 20.0,
                        width: 300.0,
                        height: 160.0,
                        rotation: 30.0,
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(applied.accepted_revision, 2);
        assert_eq!(
            applied.history_item.changes,
            vec![AppliedChange::GeometryChanged {
                id: NodeId(1),
                before: Geometry {
                    x: 0.0,
                    y: 0.0,
                    width: 240.0,
                    height: 160.0,
                    rotation: 0.0,
                },
                after: Geometry {
                    x: 10.0,
                    y: 20.0,
                    width: 300.0,
                    height: 160.0,
                    rotation: 30.0,
                },
            }]
        );
    }

    #[test]
    fn stale_revision_does_not_modify_document() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            Transaction {
                id: TransactionId(8),
                base_revision: 0,
                commands: vec![Command::Rename {
                    id: NodeId(1),
                    name: "Stale".into(),
                }],
            },
            Origin::LocalUser,
        );
        assert_eq!(
            result,
            Err(CommandError::RevisionConflict {
                expected: 1,
                actual: 0
            })
        );
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
    }

    #[test]
    fn deleted_id_cannot_be_reused() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(1, vec![Command::Delete { id: NodeId(1) }]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            transaction(2, vec![Command::Create(node(1))]),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::RetiredNodeId { id: NodeId(1) }));
    }

    #[test]
    fn invalid_appearance_rolls_back_the_whole_transaction() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::LocalUser,
            )
            .unwrap();
        let result = document.submit(
            transaction(
                1,
                vec![
                    Command::Rename {
                        id: NodeId(1),
                        name: "Changed".into(),
                    },
                    Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "".into(),
                            stroke: "#00000000".into(),
                            stroke_width: 0.0,
                            opacity: 1.0,
                            corner_radius: 0.0,
                            visible: true,
                            locked: false,
                        },
                    },
                ],
            ),
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::InvalidAppearance));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
    }

    #[test]
    fn canonical_color_space_is_hashed_and_invalid_color_rolls_back() {
        let mut srgb = Document::empty();
        let mut p3 = Document::empty();
        let srgb_node = node(1);
        let mut p3_node = node(1);
        p3_node.fill = Paint::Solid(Color::new(ColorSpace::DisplayP3, [0.2, 0.8, 0.4], 1.0).unwrap());
        srgb.submit(transaction(0, vec![Command::Create(srgb_node)]), Origin::LocalUser).unwrap();
        p3.submit(transaction(0, vec![Command::Create(p3_node)]), Origin::LocalUser).unwrap();
        assert_ne!(srgb.canonical_hash_hex(), p3.canonical_hash_hex());

        let mut invalid = node(2);
        invalid.fill = Paint::Solid(Color { space: ColorSpace::Srgb, components: [f32::NAN, 0.0, 0.0], alpha: 1.0 });
        assert_eq!(
            p3.submit(transaction(1, vec![Command::Create(invalid)]), Origin::LocalUser),
            Err(CommandError::InvalidAppearance)
        );
        assert_eq!(p3.nodes().count(), 1);
    }

    #[test]
    fn stroke_and_width_are_canonical_hashed_and_undoable() {
        let mut document = Document::empty();
        document.submit(transaction(0, vec![Command::Create(node(1))]), Origin::LocalUser).unwrap();
        let baseline_hash = document.canonical_hash_hex();

        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#fff".into(),
                            stroke: "#2563eb".into(),
                            stroke_width: 3.0,
                            opacity: 1.0,
                            corner_radius: 0.0,
                            visible: true,
                            locked: false,
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke, Paint::Solid(Color::from_srgb_u8([37, 99, 235], 255)));
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 3.0);
        assert_ne!(document.canonical_hash_hex(), baseline_hash);

        document.undo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 0.0);
        assert_eq!(document.canonical_hash_hex(), baseline_hash);
        document.redo().unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().stroke_width, 3.0);
    }

    #[test]
    fn document_color_profile_is_hashed_undoable_and_operation_hashed() {
        let mut document = Document::empty();
        let srgb_hash = document.canonical_hash_hex();
        let transaction = Transaction {
            id: TransactionId(77),
            base_revision: 0,
            commands: vec![Command::SetDocumentColorProfile {
                profile: DocumentColorProfile::DisplayP3,
            }],
        };
        let payload_hash = OperationEnvelope::payload_hash_for(&transaction);
        document.submit(transaction, Origin::LocalUser).unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::DisplayP3);
        assert_ne!(document.canonical_hash_hex(), srgb_hash);

        let different_payload = OperationEnvelope::payload_hash_for(&Transaction {
            id: TransactionId(78),
            base_revision: 0,
            commands: vec![Command::SetDocumentColorProfile {
                profile: DocumentColorProfile::Srgb,
            }],
        });
        assert_ne!(payload_hash, different_payload);
        document.undo().unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::Srgb);
        assert_eq!(document.canonical_hash_hex(), srgb_hash);
        document.redo().unwrap();
        assert_eq!(document.color_profile(), DocumentColorProfile::DisplayP3);
    }

    #[test]
    fn linear_gradient_is_canonical_hashed_and_undoable() {
        let gradient = crate::color::LinearGradient::new(
            [0.0, 0.0],
            [1.0, 1.0],
            vec![
                crate::color::GradientStop { position: 0.0, color: Color::from_srgb_u8([16, 24, 48], 255) },
                crate::color::GradientStop { position: 1.0, color: Color::from_srgb_u8([112, 224, 192], 204) },
            ],
        )
        .unwrap();
        let mut gradient_node = node(1);
        gradient_node.fill = Paint::LinearGradient(gradient.clone());
        let mut document = Document::empty();
        document
            .submit(transaction(0, vec![Command::Create(gradient_node)]), Origin::LocalUser)
            .unwrap();
        let gradient_hash = document.canonical_hash_hex();
        let gradient_bytes = document.memory_stats().node_bytes;
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetAppearance {
                        id: NodeId(1),
                        appearance: Appearance {
                            fill: "#ffffff".into(),
                            stroke: "#00000000".into(),
                            stroke_width: 0.0,
                            opacity: 1.0,
                            corner_radius: 0.0,
                            visible: true,
                            locked: false,
                        },
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_ne!(document.canonical_hash_hex(), gradient_hash);
        assert!(document.memory_stats().node_bytes < gradient_bytes);
        document.undo().unwrap();
        assert_eq!(document.canonical_hash_hex(), gradient_hash);
        assert_eq!(document.memory_stats().node_bytes, gradient_bytes);
        assert_eq!(document.node(NodeId(1)).unwrap().fill, Paint::LinearGradient(gradient));
    }

    #[test]
    fn position_ids_define_deterministic_sibling_order_and_gap_allocation() {
        let left = PositionId { key: 10, actor: ActorId(1) };
        let right = PositionId { key: 20, actor: ActorId(2) };
        assert_eq!(PositionId::between(Some(left), Some(right), ActorId(9)).unwrap(), PositionId { key: 15, actor: ActorId(9) });
        assert_eq!(PositionId::between(Some(left), Some(PositionId { key: 11, actor: ActorId(2) }), ActorId(9)), Err(PositionError::NoSpaceBetween));

        let mut document = Document::empty();
        let mut parent = node(1);
        parent.position = PositionId { key: 50, actor: ActorId(0) };
        let mut later = node(2);
        later.parent_id = Some(NodeId(1));
        later.position = PositionId { key: 20, actor: ActorId(1) };
        let mut earlier = node(3);
        earlier.parent_id = Some(NodeId(1));
        earlier.position = PositionId { key: 10, actor: ActorId(2) };
        document
            .submit(
                transaction(0, vec![Command::Create(parent), Command::Create(later), Command::Create(earlier)]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.ordered_nodes().iter().map(|node| node.id).collect::<Vec<_>>(), vec![NodeId(1), NodeId(3), NodeId(2)]);
        assert_eq!(document.position_between(Some(NodeId(1)), Some(NodeId(3)), Some(NodeId(2)), ActorId(4)).unwrap(), PositionId { key: 15, actor: ActorId(4) });
    }

    #[test]
    fn text_content_is_canonical_undoable_and_operation_hashed() {
        let mut document = Document::empty();
        let mut text_node = node(1);
        text_node.kind = NodeKind::Text;
        text_node.text = "Before".into();
        document
            .submit(
                transaction(0, vec![Command::Create(text_node)]),
                Origin::LocalUser,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![Command::SetText {
                        id: NodeId(1),
                        text: "After".into(),
                    }],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "Before");
        assert_eq!(document.redo(), Some(4));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");

        let before = Transaction {
            id: TransactionId(90),
            base_revision: 4,
            commands: vec![Command::SetText { id: NodeId(1), text: "Before".into() }],
        };
        let after = Transaction {
            id: TransactionId(91),
            base_revision: 4,
            commands: vec![Command::SetText { id: NodeId(1), text: "After".into() }],
        };
        assert_ne!(
            OperationEnvelope::payload_hash_for(&before),
            OperationEnvelope::payload_hash_for(&after)
        );
        assert_eq!(
            document.submit(
                transaction(
                    4,
                    vec![Command::SetText {
                        id: NodeId(1),
                        text: "x".repeat(MAX_TEXT_BYTES + 1),
                    }],
                ),
                Origin::LocalUser,
            ),
            Err(CommandError::InvalidText)
        );
        assert_eq!(document.node(NodeId(1)).unwrap().text, "After");
    }

    #[test]
    fn undo_and_redo_replay_semantic_changes_without_reusing_ids() {
        let mut document = Document::empty();
        document
            .submit(
                transaction(0, vec![Command::Create(node(1))]),
                Origin::SystemRepair,
            )
            .unwrap();
        document
            .submit(
                transaction(
                    1,
                    vec![
                        Command::UpdateGeometry {
                            id: NodeId(1),
                            x: 48.0,
                            y: 16.0,
                            width: 300.0,
                            height: 160.0,
                            rotation: 15.0,
                        },
                        Command::Rename {
                            id: NodeId(1),
                            name: "Moved card".into(),
                        },
                    ],
                ),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.undo(), Some(3));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Card");
        assert_eq!(document.node(NodeId(1)).unwrap().x, 0.0);
        assert_eq!(document.node(NodeId(1)).unwrap().rotation, 0.0);
        assert_eq!(document.redo(), Some(4));
        assert_eq!(document.node(NodeId(1)).unwrap().name, "Moved card");
        assert_eq!(document.node(NodeId(1)).unwrap().x, 48.0);
        assert_eq!(document.node(NodeId(1)).unwrap().rotation, 15.0);

        document
            .submit(
                transaction(4, vec![Command::Delete { id: NodeId(1) }]),
                Origin::LocalUser,
            )
            .unwrap();
        assert_eq!(document.undo(), Some(6));
        assert!(document.node(NodeId(1)).is_some());
        assert_eq!(document.redo(), Some(7));
        assert!(document.node(NodeId(1)).is_none());
        assert_eq!(
            document.submit(
                transaction(7, vec![Command::Create(node(1))]),
                Origin::LocalUser
            ),
            Err(CommandError::RetiredNodeId { id: NodeId(1) })
        );
    }

    #[test]
    fn retrying_an_accepted_transaction_is_idempotent() {
        let mut document = Document::empty();
        let transaction = Transaction {
            id: TransactionId(99),
            base_revision: 0,
            commands: vec![Command::Create(node(1))],
        };

        let first = document.submit(transaction.clone(), Origin::LocalUser).unwrap();
        let retried = document.submit(transaction, Origin::LocalUser).unwrap();

        assert_eq!(retried, first);
        assert_eq!(document.revision, 1);
        assert_eq!(document.nodes().count(), 1);
        assert_eq!(document.undo(), Some(2));
        assert!(document.undo().is_none());
        assert_eq!(
            document.submit(
                Transaction {
                    id: TransactionId(99),
                    base_revision: 2,
                    commands: vec![Command::Create(node(2))],
                },
                Origin::LocalUser,
            ),
            Err(CommandError::TransactionIdConflict { id: TransactionId(99) })
        );
    }

    #[test]
    fn operation_envelope_is_idempotent_and_canonicalizes_causal_parent_order() {
        let document_id = DocumentId(41);
        let transaction = Transaction {
            id: TransactionId(81),
            base_revision: 0,
            commands: vec![Command::Create(node(1))],
        };
        let first_envelope = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![OperationId(3), OperationId(2), OperationId(3)],
            transaction.clone(),
        );
        let retry_envelope = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![OperationId(2), OperationId(3)],
            transaction,
        );
        assert_eq!(first_envelope.fingerprint(), retry_envelope.fingerprint());

        let mut document = Document::with_id(document_id);
        let first = document
            .submit_operation(first_envelope, Origin::RemoteOperation)
            .unwrap();
        let retried = document
            .submit_operation(retry_envelope, Origin::RemoteOperation)
            .unwrap();
        assert_eq!(first, retried);
        assert_eq!(document.revision, 1);
        assert_eq!(document.memory_stats().operation_dedupe_items, 1);

        let conflict = OperationEnvelope::new(
            document_id,
            OperationId(91),
            ActorId(7),
            vec![],
            Transaction {
                id: TransactionId(82),
                base_revision: 1,
                commands: vec![Command::Create(node(2))],
            },
        );
        assert_eq!(
            document.submit_operation(conflict, Origin::RemoteOperation),
            Err(CommandError::OperationIdConflict {
                id: OperationId(91)
            })
        );
        assert_eq!(document.revision, 1);
    }

    #[test]
    fn operation_envelope_rejects_tampering_before_document_mutation() {
        let document_id = DocumentId(42);
        let base = OperationEnvelope::new(
            document_id,
            OperationId(92),
            ActorId(7),
            vec![],
            Transaction {
                id: TransactionId(83),
                base_revision: 0,
                commands: vec![Command::Create(node(1))],
            },
        );
        let mut document = Document::with_id(document_id);

        let mut tampered = base.clone();
        tampered.payload_hash = [0; 32];
        assert_eq!(
            document.submit_operation(tampered, Origin::RemoteOperation),
            Err(CommandError::OperationPayloadHashMismatch)
        );
        let mut wrong_schema = base.clone();
        wrong_schema.schema_version = 99;
        assert_eq!(
            document.submit_operation(wrong_schema, Origin::RemoteOperation),
            Err(CommandError::UnsupportedOperationSchema { found: 99 })
        );
        let mut wrong_document = base;
        wrong_document.document_id = DocumentId(99);
        assert_eq!(
            document.submit_operation(wrong_document, Origin::RemoteOperation),
            Err(CommandError::OperationDocumentMismatch {
                expected: document_id,
                actual: DocumentId(99),
            })
        );
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);
    }

    #[test]
    fn legal_operation_replay_converges_to_the_same_document_hash() {
        let document_id = DocumentId(43);
        let create = OperationEnvelope::new(
            document_id,
            OperationId(100),
            ActorId(8),
            vec![],
            Transaction {
                id: TransactionId(1000),
                base_revision: 0,
                commands: vec![Command::Create(node(1))],
            },
        );
        let rename = OperationEnvelope::new(
            document_id,
            OperationId(101),
            ActorId(8),
            vec![OperationId(100)],
            Transaction {
                id: TransactionId(1001),
                base_revision: 1,
                commands: vec![Command::Rename {
                    id: NodeId(1),
                    name: "Shared card".into(),
                }],
            },
        );
        let mut first = Document::with_id(document_id);
        let mut second = Document::with_id(document_id);
        for document in [&mut first, &mut second] {
            document
                .submit_operation(create.clone(), Origin::RemoteOperation)
                .unwrap();
            document
                .submit_operation(rename.clone(), Origin::RemoteOperation)
                .unwrap();
        }
        assert_eq!(first.revision, 2);
        assert_eq!(first.canonical_hash(), second.canonical_hash());
        assert!(!first.can_undo(), "remote operations do not enter local undo");
    }

    #[test]
    fn canonical_hash_is_independent_of_legal_command_order() {
        let mut first = Document::empty();
        let mut second = Document::empty();
        first
            .submit(
                Transaction {
                    id: TransactionId(1),
                    base_revision: 0,
                    commands: vec![Command::Create(node(1)), Command::Create(node(2))],
                },
                Origin::Import,
            )
            .unwrap();
        second
            .submit(
                Transaction {
                    id: TransactionId(2),
                    base_revision: 0,
                    commands: vec![Command::Create(node(2)), Command::Create(node(1))],
                },
                Origin::Import,
            )
            .unwrap();

        assert_eq!(first.canonical_hash(), second.canonical_hash());
        second
            .submit(
                Transaction {
                    id: TransactionId(3),
                    base_revision: 1,
                    commands: vec![Command::Delete { id: NodeId(2) }],
                },
                Origin::Import,
            )
            .unwrap();
        assert_ne!(first.canonical_hash(), second.canonical_hash());
    }

    #[test]
    fn resource_limits_reject_an_oversized_transaction_before_mutation() {
        let mut document = Document::empty();
        let commands = vec![Command::Delete { id: NodeId(1) }; MAX_TRANSACTION_COMMANDS + 1];
        assert_eq!(
            document.submit(
                Transaction { id: TransactionId(1), base_revision: 0, commands },
                Origin::LocalUser,
            ),
            Err(CommandError::ResourceLimit)
        );
        assert_eq!(document.revision, 0);
        assert_eq!(document.nodes().count(), 0);

        let mut huge = node(2);
        huge.name = "x".repeat(MAX_TRANSACTION_BYTES);
        assert_eq!(
            document.submit(
                Transaction { id: TransactionId(2), base_revision: 0, commands: vec![Command::Create(huge)] },
                Origin::LocalUser,
            ),
            Err(CommandError::ResourceLimit)
        );
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn one_hundred_thousand_node_fixture_is_admitted_and_next_node_is_rejected() {
        let mut document = Document::empty();
        for id in 1..=MAX_DOCUMENT_NODES as u128 {
            document.seed_node(node(id)).unwrap();
        }
        let before = document.memory_stats();
        assert_eq!(before.node_count, MAX_DOCUMENT_NODES);
        assert!(before.node_bytes <= MAX_DOCUMENT_BYTES);

        let result = document.submit(
            Transaction {
                id: TransactionId(50_000),
                base_revision: 0,
                commands: vec![Command::Create(node(MAX_DOCUMENT_NODES as u128 + 1))],
            },
            Origin::LocalUser,
        );
        assert_eq!(result, Err(CommandError::ResourceLimit));
        assert_eq!(document.node_count(), MAX_DOCUMENT_NODES);
        assert_eq!(document.memory_stats().node_bytes, before.node_bytes);
        assert_eq!(document.revision, 0);
    }

    #[test]
    fn document_byte_budget_rejects_text_growth_without_mutation() {
        let mut document = Document::empty();
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "small".into();
        document.seed_node(text).unwrap();

        // Exercise the admission boundary without allocating a 256 MiB test fixture.
        document.node_bytes = MAX_DOCUMENT_BYTES;
        let result = document.submit(
            Transaction {
                id: TransactionId(50_001),
                base_revision: 0,
                commands: vec![Command::SetText {
                    id: NodeId(1),
                    text: "this growth must be rejected before mutation".into(),
                }],
            },
            Origin::LocalUser,
        );

        assert_eq!(result, Err(CommandError::ResourceLimit));
        assert_eq!(document.node(NodeId(1)).unwrap().text, "small");
        assert_eq!(document.revision, 0);
        assert_eq!(document.memory_stats().node_bytes, MAX_DOCUMENT_BYTES);
    }

    #[test]
    fn undo_and_redo_keep_node_byte_accounting_in_sync() {
        let mut document = Document::empty();
        let mut text = node(1);
        text.kind = NodeKind::Text;
        text.text = "before".into();
        document.seed_node(text).unwrap();
        let initial_bytes = document.memory_stats().node_bytes;

        document
            .submit(
                Transaction {
                    id: TransactionId(50_002),
                    base_revision: 0,
                    commands: vec![
                        Command::Rename { id: NodeId(1), name: "A longer name".into() },
                        Command::SetText { id: NodeId(1), text: "A longer canonical text value".into() },
                    ],
                },
                Origin::LocalUser,
            )
            .unwrap();
        let changed_bytes = document.memory_stats().node_bytes;
        assert!(changed_bytes > initial_bytes);

        document.undo().unwrap();
        assert_eq!(document.memory_stats().node_bytes, initial_bytes);
        document.redo().unwrap();
        assert_eq!(document.memory_stats().node_bytes, changed_bytes);
    }

    #[test]
    fn undo_history_has_a_bounded_count_and_byte_budget() {
        let mut document = Document::empty();
        for id in 1..=(MAX_HISTORY_ITEMS as u128 + 1) {
            document
                .submit(
                    Transaction {
                        id: TransactionId(10_000 + id),
                        base_revision: document.revision,
                        commands: vec![Command::Create(node(id))],
                    },
                    Origin::LocalUser,
                )
                .unwrap();
        }

        let stats = document.memory_stats();
        assert_eq!(stats.undo_items, MAX_HISTORY_ITEMS);
        assert!(stats.undo_bytes <= MAX_HISTORY_BYTES);
        assert!(stats.dedupe_bytes <= MAX_DEDUPE_BYTES);
        for _ in 0..MAX_HISTORY_ITEMS {
            assert!(document.undo().is_some());
        }
        assert!(document.undo().is_none());
    }
}
