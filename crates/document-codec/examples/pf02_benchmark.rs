use editor_core::{
    ActorId, BlendMode, BooleanOperation, Command, DEFAULT_PAGE_ID, Document, Node, NodeId,
    NodeKind, Origin, PositionId, StrokeAlign, Transaction, TransactionId,
};
use makefigma_document_codec::snapshot_from_document;
use std::{collections::BTreeMap, env, hint::black_box, time::Instant};

const ENGINE_SEMANTICS_VERSION: u32 = 3;

fn main() {
    let node_count = argument(1, 10_000);
    let sample_count = argument(2, 30);
    assert!(matches!(node_count, 10_000 | 100_000));
    assert!(sample_count >= 30);

    let build_started = Instant::now();
    let mut document = build_fixture(node_count);
    let build_ms = build_started.elapsed().as_secs_f64() * 1_000.0;

    for warmup in 0..5u128 {
        black_box(document.ordered_children(DEFAULT_PAGE_ID, None).unwrap());
        black_box(document.ordered_nodes_on_page(DEFAULT_PAGE_ID).unwrap());
        black_box(document.canonical_hash());
        black_box(snapshot_from_document(&document, ENGINE_SEMANTICS_VERSION).unwrap());
        rename_root(&mut document, warmup, true);
    }

    let ordered_children_ms = samples(sample_count, || {
        black_box(document.ordered_children(DEFAULT_PAGE_ID, None).unwrap());
    });
    let ordered_page_ms = samples(sample_count, || {
        black_box(document.ordered_nodes_on_page(DEFAULT_PAGE_ID).unwrap());
    });
    let hash_ms = samples(sample_count, || {
        black_box(document.canonical_hash());
    });
    let snapshot_ms = samples(sample_count, || {
        black_box(snapshot_from_document(&document, ENGINE_SEMANTICS_VERSION).unwrap());
    });
    let mut transaction_ms = Vec::with_capacity(sample_count);
    for sample in 0..sample_count {
        let started = Instant::now();
        rename_root(&mut document, sample as u128, false);
        transaction_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
    }
    let candidate_clone_us = samples_scaled(sample_count, 1_000_000.0, || {
        black_box(document.clone());
    });

    let snapshot_bytes = snapshot_from_document(&document, ENGINE_SEMANTICS_VERSION)
        .unwrap()
        .len();
    let memory = document.memory_stats();
    let canonical_hash = document.canonical_hash_hex();
    println!(
        "{{\"format\":\"makefigma-pf02-native-v2\",\"nodeCount\":{},\"sampleCount\":{},\"buildMs\":{:.3},\"rootCount\":{},\"snapshotBytes\":{},\"canonicalNodeBytes\":{},\"canonicalHash\":\"{}\",\"historyItems\":{},\"logicalNodePayloadCopiesPerRename\":1,\"metrics\":{{\"candidateCloneMicros\":{},\"orderedChildrenMs\":{},\"orderedPageMs\":{},\"transactionMs\":{},\"canonicalHashMs\":{},\"snapshotMs\":{}}}}}",
        node_count,
        sample_count,
        build_ms,
        document
            .ordered_children(DEFAULT_PAGE_ID, None)
            .unwrap()
            .len(),
        snapshot_bytes,
        memory.node_bytes,
        canonical_hash,
        memory.undo_items,
        summary_json(&candidate_clone_us),
        summary_json(&ordered_children_ms),
        summary_json(&ordered_page_ms),
        summary_json(&transaction_ms),
        summary_json(&hash_ms),
        summary_json(&snapshot_ms),
    );
}

fn build_fixture(node_count: usize) -> Document {
    let structural_count = node_count / 5;
    let mut document = Document::empty();
    let mut next_id = 1u128;
    for _ in 0..structural_count {
        let group_id = NodeId(next_id);
        let mut group = node(next_id);
        group.kind = NodeKind::Group;
        group.name = "PF-02 group".into();
        document.seed_node(group).unwrap();
        next_id += 1;
        let mut child = node(next_id);
        child.parent_id = Some(group_id);
        document.seed_node(child).unwrap();
        next_id += 1;
    }
    for _ in 0..structural_count {
        let boolean_id = NodeId(next_id);
        let mut boolean = node(next_id);
        boolean.kind = NodeKind::BooleanOperation;
        boolean.boolean_operation = Some(BooleanOperation::Union);
        boolean.name = "PF-02 boolean".into();
        document.seed_node(boolean).unwrap();
        next_id += 1;
        for _ in 0..2 {
            let mut operand = node(next_id);
            operand.parent_id = Some(boolean_id);
            document.seed_node(operand).unwrap();
            next_id += 1;
        }
    }
    assert_eq!(next_id - 1, node_count as u128);
    document.validate_seeded_structure().unwrap();
    document
}

fn rename_root(document: &mut Document, sample: u128, warmup: bool) {
    let transaction_id = if warmup {
        1_000 + sample
    } else {
        10_000 + sample
    };
    document
        .submit(
            Transaction {
                id: TransactionId(transaction_id),
                base_revision: document.revision,
                commands: vec![Command::Rename {
                    id: NodeId(1),
                    name: format!(
                        "PF-02 {} {sample}",
                        if warmup { "warmup" } else { "sample" }
                    ),
                }],
            },
            Origin::LocalUser,
        )
        .unwrap();
}

fn samples(count: usize, operation: impl FnMut()) -> Vec<f64> {
    samples_scaled(count, 1_000.0, operation)
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
    let index = ((sorted.len() - 1) as f64 * percentile).ceil() as usize;
    sorted[index]
}

fn argument(index: usize, fallback: usize) -> usize {
    env::args()
        .nth(index)
        .map(|value| {
            value
                .parse()
                .expect("benchmark arguments must be positive integers")
        })
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
        name: "PF-02 rectangle".into(),
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
