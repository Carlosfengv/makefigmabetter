use editor_core::{
    ActorId, AppliedChange, AutoLayout, BlendMode, Command, Document, LayoutAlignment, LayoutMode,
    Node, NodeId, NodeKind, Origin, PositionId, StrokeAlign, Transaction, TransactionId,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    hint::black_box,
    time::Instant,
};

fn main() {
    let node_count = argument(1, 100_000);
    let layout_children = argument(2, 9_999);
    let sample_count = argument(3, 30);
    assert!(node_count >= layout_children + 1);
    assert!(layout_children <= 9_999);

    let build_started = Instant::now();
    let mut document = build_fixture(node_count, layout_children);
    let build_ms = elapsed_ms(build_started);
    let node_bytes_before = document.memory_stats().node_bytes;

    let mut transaction_ms = Vec::with_capacity(sample_count);
    let mut last_change_count = 0usize;
    let mut last_touched_node_count = 0usize;
    let mut last_history_bytes = 0usize;
    for sample in 0..sample_count {
        let started = Instant::now();
        let applied = resize_layout_frame(&mut document, sample as u128);
        transaction_ms.push(elapsed_ms(started));
        last_change_count = applied.history_item.changes.len();
        let mut touched_nodes = BTreeSet::new();
        for change in &applied.history_item.changes {
            collect_touched_node_ids(change, &mut touched_nodes);
        }
        last_touched_node_count = touched_nodes.len();
        last_history_bytes = applied.history_item.estimated_bytes();
    }
    let candidate_clone_us = samples_scaled(30, 1_000_000.0, || {
        black_box(document.clone());
    });
    let memory = document.memory_stats();

    println!(
        "{{\"format\":\"makefigma-pf02-layout-cascade-v1\",\"nodeCount\":{},\"layoutChildren\":{},\"sampleCount\":{},\"buildMs\":{:.3},\"lastAppliedChanges\":{},\"lastTouchedNodeCount\":{},\"lastHistoryEstimatedBytes\":{},\"nodeBytesBefore\":{},\"nodeBytesAfter\":{},\"historyItems\":{},\"dedupeItems\":{},\"canonicalHash\":\"{}\",\"metrics\":{{\"candidateCloneMicros\":{},\"transactionMs\":{}}}}}",
        node_count,
        layout_children,
        sample_count,
        build_ms,
        last_change_count,
        last_touched_node_count,
        last_history_bytes,
        node_bytes_before,
        memory.node_bytes,
        memory.undo_items,
        memory.dedupe_items,
        document.canonical_hash_hex(),
        summary_json(&candidate_clone_us),
        summary_json(&transaction_ms),
    );
}

fn collect_touched_node_ids(change: &AppliedChange, ids: &mut BTreeSet<NodeId>) {
    match change {
        AppliedChange::Composite { changes } => {
            for change in changes {
                collect_touched_node_ids(change, ids);
            }
        }
        AppliedChange::NodeCreated { node }
        | AppliedChange::NodeDeleted { node }
        | AppliedChange::NodeRestored { node } => {
            ids.insert(node.id);
        }
        AppliedChange::GeometryChanged { id, .. }
        | AppliedChange::NameChanged { id, .. }
        | AppliedChange::AppearanceChanged { id, .. }
        | AppliedChange::PaintStacksChanged { id, .. }
        | AppliedChange::AutoLayoutChanged { id, .. }
        | AppliedChange::VectorPathChanged { id, .. }
        | AppliedChange::NodeRecordChanged { id, .. }
        | AppliedChange::BooleanOperationChanged { id, .. }
        | AppliedChange::MaskChanged { id, .. }
        | AppliedChange::ExtensionsChanged { id, .. }
        | AppliedChange::NodeAssetChanged { id, .. }
        | AppliedChange::TextChanged { id, .. }
        | AppliedChange::TextPropertiesChanged { id, .. }
        | AppliedChange::NodePositionChanged { id, .. }
        | AppliedChange::NodeParentChanged { id, .. } => {
            ids.insert(*id);
        }
        AppliedChange::PageCreated { .. }
        | AppliedChange::DocumentColorProfileChanged { .. }
        | AppliedChange::AssetRegistered { .. }
        | AppliedChange::TextStyleRegistered { .. } => {}
    }
}

fn build_fixture(node_count: usize, layout_children: usize) -> Document {
    let mut document = Document::empty();
    let mut frame = node(1);
    frame.kind = NodeKind::Frame;
    frame.name = "PF-02 cascade frame".into();
    frame.width = 200_000.0;
    frame.height = 100.0;
    document.seed_node(frame.clone()).unwrap();

    for id in 2..=(layout_children as u128 + 1) {
        let mut child = node(id);
        child.parent_id = Some(frame.id);
        child.width = 10.0;
        child.height = 10.0;
        document.seed_node(child).unwrap();
    }
    for id in (layout_children as u128 + 2)..=node_count as u128 {
        document.seed_node(node(id)).unwrap();
    }
    document
        .seed_auto_layout(
            frame.id,
            AutoLayout {
                mode: LayoutMode::Horizontal,
                primary_alignment: LayoutAlignment::SpaceBetween,
                ..AutoLayout::default()
            },
        )
        .unwrap();
    document.validate_seeded_structure().unwrap();
    document
}

fn resize_layout_frame(document: &mut Document, sample: u128) -> editor_core::AppliedTransaction {
    let frame = document.node(NodeId(1)).unwrap();
    let target_width = if frame.width < 205_000.0 {
        210_000.0
    } else {
        200_000.0
    };
    document
        .submit(
            Transaction {
                id: TransactionId(80_000 + sample),
                base_revision: document.revision,
                commands: vec![Command::UpdateGeometry {
                    id: NodeId(1),
                    x: frame.x,
                    y: frame.y,
                    width: target_width,
                    height: frame.height,
                    rotation: frame.rotation,
                }],
            },
            Origin::LocalUser,
        )
        .unwrap()
}

fn samples_scaled(count: usize, scale: f64, mut operation: impl FnMut()) -> Vec<f64> {
    (0..count)
        .map(|_| {
            let started = Instant::now();
            operation();
            started.elapsed().as_secs_f64() * scale
        })
        .collect()
}

fn summary_json(samples: &[f64]) -> String {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    format!(
        "{{\"p50\":{:.3},\"p95\":{:.3},\"max\":{:.3}}}",
        percentile(&sorted, 0.50),
        percentile(&sorted, 0.95),
        sorted.last().copied().unwrap_or_default(),
    )
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * percentile).ceil() as usize]
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1_000.0
}

fn argument(index: usize, fallback: usize) -> usize {
    env::args()
        .nth(index)
        .map(|value| value.parse().expect("arguments must be positive integers"))
        .unwrap_or(fallback)
}

fn node(id: u128) -> Node {
    Node {
        id: NodeId(id),
        parent_id: None,
        position: PositionId {
            key: id,
            actor: ActorId(1),
        },
        name: "PF-02 cascade rectangle".into(),
        kind: NodeKind::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 100.0,
        rotation: 0.0,
        fill: "#ffffffff".into(),
        stroke: "#00000000".into(),
        fills: Vec::new(),
        strokes: Vec::new(),
        stroke_width: 0.0,
        stroke_cap_start: Default::default(),
        stroke_cap_end: Default::default(),
        stroke_join: Default::default(),
        stroke_miter_limit: 10.0,
        stroke_dash_pattern: Vec::new(),
        stroke_weights: Vec::new(),
        stroke_align: StrokeAlign::Inside,
        arc_data: None,
        parametric_shape: None,
        vector_path: None,
        boolean_operation: None,
        relative_transform: None,
        opacity: 1.0,
        blend_mode: BlendMode::Normal,
        drop_shadow: None,
        effect_stack: Vec::new(),
        corner_radius: 0.0,
        corner_radii: Vec::new(),
        corner_smoothing: 0.0,
        constraints: None,
        text: String::new(),
        visible: true,
        locked: false,
        contents_hidden: false,
        clips_content: false,
        extensions: BTreeMap::new(),
    }
}
