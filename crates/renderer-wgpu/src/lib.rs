//! A deterministic Render Graph plan for the WebGPU executor.
//!
//! This crate deliberately knows no `Document`, DOM canvas, `wgpu::Device`, or
//! GPU resource handle. The Engine Worker projects Canonical Document state to
//! [`Scene`]; a platform-specific executor later turns this immutable plan into
//! WebGPU commands. Keeping that boundary explicit prevents presentation cache
//! loss or Device Lost recovery from changing durable document state.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Rect {
    pub fn intersects(self, other: Self) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneNodeKind {
    Frame,
    Section,
    Rectangle,
    Ellipse,
    Image,
    Text,
    /// A stroked open segment. It is currently routed through the main scene
    /// plan; the executor receives its exact stroke geometry in Phase 2.
    Line,
    /// Structural only: child nodes paint in document order; a Group never
    /// contributes a primitive by itself.
    Group,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SceneNode {
    /// Stable Canonical NodeId rendered as a platform-neutral value.
    pub id: u128,
    pub kind: SceneNodeKind,
    pub bounds: Rect,
    /// Canonical sibling order. The Scene constructor preserves it exactly.
    pub z_index: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    /// Revision from which this derived presentation Scene was produced.
    pub document_revision: u64,
    pub nodes: Vec<SceneNode>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtySet {
    pub document_revision: u64,
    pub full_scene: bool,
    pub node_ids: BTreeSet<u128>,
}

impl DirtySet {
    pub fn full_scene(document_revision: u64) -> Self {
        Self {
            document_revision,
            full_scene: true,
            node_ids: BTreeSet::new(),
        }
    }

    pub fn nodes(document_revision: u64, node_ids: impl IntoIterator<Item = u128>) -> Self {
        Self {
            document_revision,
            full_scene: false,
            node_ids: node_ids.into_iter().collect(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderPass {
    MainScene,
    Images,
    Text,
    Overlay,
    Composite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderCommand {
    pub node_id: u128,
    pub pass: RenderPass,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderGraph {
    pub document_revision: u64,
    pub dirty: DirtySet,
    pub passes: Vec<RenderPass>,
    pub commands: Vec<RenderCommand>,
}

/// Matches the stable WGSL instance layout used by the platform executor:
/// geometry (8 floats), then encoded sRGB non-premultiplied fill and stroke
/// RGBA. This is the exact contract of the current WGSL executor, whose blend
/// state uses `src-alpha` for the source color factor.
pub const GPU_INSTANCE_FLOATS: usize = 16;

#[derive(Debug, Clone, PartialEq)]
pub struct GpuPrimitive {
    pub node_id: u128,
    pub kind: SceneNodeKind,
    pub bounds: Rect,
    pub rotation_degrees: f32,
    pub corner_radius: f32,
    pub stroke_width: f32,
    /// Uniform closed-shape Center/Outside strokes submit an expanded quad to
    /// the shared WGSL ring shader. Arc/Donut and detailed outlines never set
    /// this value.
    pub shape_stroke_outset: f32,
    pub fill_rgba: [f32; 4],
    pub stroke_rgba: [f32; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct GpuInstanceBatch {
    pub instance_floats: Vec<f32>,
    pub rendered_node_ids: Vec<u128>,
}

/// Builds a platform-neutral solid-shape instance buffer. Images and Text stay
/// in their dedicated passes because this batch has neither sampled textures
/// nor glyph atlas references. Colors must already match the platform
/// executor's encoded-sRGB, non-premultiplied blend contract, so no Document
/// color state is retained by the renderer.
pub fn build_gpu_instance_batch(
    primitives: impl IntoIterator<Item = GpuPrimitive>,
) -> GpuInstanceBatch {
    let mut instance_floats = Vec::new();
    let mut rendered_node_ids = Vec::new();
    for primitive in primitives {
        if !matches!(
            primitive.kind,
            SceneNodeKind::Frame | SceneNodeKind::Rectangle | SceneNodeKind::Ellipse
        ) || (primitive.fill_rgba[3] <= 0.0 && primitive.stroke_rgba[3] <= 0.0)
        {
            continue;
        }
        let closed_shape = matches!(primitive.kind, SceneNodeKind::Frame | SceneNodeKind::Rectangle | SceneNodeKind::Ellipse);
        let outset = if closed_shape { primitive.shape_stroke_outset.max(0.0) } else { 0.0 };
        let bounds = if outset > 0.0 {
            Rect {
                x: primitive.bounds.x - outset,
                y: primitive.bounds.y - outset,
                width: primitive.bounds.width + outset * 2.0,
                height: primitive.bounds.height + outset * 2.0,
            }
        } else {
            primitive.bounds
        };
        let width = bounds.width.abs();
        let height = bounds.height.abs();
        let limiting_dimension = width.min(height);
        let outer_radius = (primitive.corner_radius
            + if primitive.kind == SceneNodeKind::Ellipse {
                0.0
            } else {
                outset
            })
            .max(0.0)
            .min(limiting_dimension / 2.0);
        let inside_stroke_width = if primitive.stroke_rgba[3] > 0.0 {
            primitive
                .stroke_width
                .max(0.0)
                .min(limiting_dimension / 2.0)
        } else {
            0.0
        };
        instance_floats.extend_from_slice(&[
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            primitive.rotation_degrees,
            if primitive.kind == SceneNodeKind::Ellipse {
                1.0
            } else {
                0.0
            },
            outer_radius,
            inside_stroke_width,
            primitive.fill_rgba[0],
            primitive.fill_rgba[1],
            primitive.fill_rgba[2],
            primitive.fill_rgba[3],
            primitive.stroke_rgba[0],
            primitive.stroke_rgba[1],
            primitive.stroke_rgba[2],
            primitive.stroke_rgba[3],
        ]);
        rendered_node_ids.push(primitive.node_id);
    }
    GpuInstanceBatch {
        instance_floats,
        rendered_node_ids,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuResourceKind {
    Buffer,
    Texture,
    Pipeline,
    GlyphAtlas,
    ImageAtlas,
    OffscreenSurface,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpuResourceDescriptor {
    /// Platform executor-owned identity, never a Canonical NodeId or handle.
    pub id: u64,
    pub kind: GpuResourceKind,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuResourceError {
    BudgetExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceState {
    Ready,
    Recovering,
    CanvasFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeviceLossOutcome {
    pub state: DeviceState,
    pub invalidated_resources: usize,
    pub generation: u64,
}

/// Bounded metadata for recreatable executor resources. Concrete WebGPU handles
/// remain in the platform executor; clearing this pool is enough to require a
/// full rebuild from the latest immutable Scene after Device Lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuResourcePool {
    max_bytes: u64,
    used_bytes: u64,
    generation: u64,
    recovery_attempts: u8,
    state: DeviceState,
    resources: BTreeMap<u64, GpuResourceDescriptor>,
}

impl GpuResourcePool {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes,
            used_bytes: 0,
            generation: 0,
            recovery_attempts: 0,
            state: DeviceState::Ready,
            resources: BTreeMap::new(),
        }
    }

    pub fn used_bytes(&self) -> u64 {
        self.used_bytes
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn state(&self) -> DeviceState {
        self.state
    }

    pub fn admit(&mut self, descriptor: GpuResourceDescriptor) -> Result<(), GpuResourceError> {
        let replacing = self
            .resources
            .get(&descriptor.id)
            .map(|resource| resource.byte_length)
            .unwrap_or(0);
        let next_bytes = self
            .used_bytes
            .saturating_sub(replacing)
            .saturating_add(descriptor.byte_length);
        if next_bytes > self.max_bytes {
            return Err(GpuResourceError::BudgetExceeded);
        }
        self.used_bytes = next_bytes;
        self.resources.insert(descriptor.id, descriptor);
        Ok(())
    }

    pub fn release(&mut self, id: u64) -> bool {
        let Some(resource) = self.resources.remove(&id) else {
            return false;
        };
        self.used_bytes = self.used_bytes.saturating_sub(resource.byte_length);
        true
    }

    /// Invalidates every recreatable resource. One recovery is allowed; a second
    /// Device Lost moves to an explainable Canvas fallback rather than retrying
    /// forever. Document state is deliberately not an input to this operation.
    pub fn device_lost(&mut self) -> DeviceLossOutcome {
        let invalidated_resources = self.resources.len();
        self.resources.clear();
        self.used_bytes = 0;
        self.generation = self.generation.saturating_add(1);
        self.state = if self.recovery_attempts == 0 {
            self.recovery_attempts = 1;
            DeviceState::Recovering
        } else {
            DeviceState::CanvasFallback
        };
        DeviceLossOutcome {
            state: self.state,
            invalidated_resources,
            generation: self.generation,
        }
    }

    pub fn finish_rebuild(&mut self) {
        if self.state == DeviceState::Recovering {
            self.state = DeviceState::Ready;
        }
    }
}

/// Compiles a current derived scene to a stable pass order. Commands never carry
/// cached GPU data; a new scene/revision therefore cannot display an old frame.
pub fn compile_render_graph(scene: &Scene, dirty: DirtySet, viewport: Rect) -> RenderGraph {
    let mut visible = scene
        .nodes
        .iter()
        .filter(|node| node.bounds.intersects(viewport))
        .collect::<Vec<_>>();
    visible.sort_by_key(|node| node.z_index);

    let commands = visible
        .into_iter()
        .map(|node| RenderCommand {
            node_id: node.id,
            pass: match node.kind {
                SceneNodeKind::Image => RenderPass::Images,
                SceneNodeKind::Text => RenderPass::Text,
                SceneNodeKind::Frame
                | SceneNodeKind::Section
                | SceneNodeKind::Rectangle
                | SceneNodeKind::Ellipse
                | SceneNodeKind::Line => {
                    RenderPass::MainScene
                }
                SceneNodeKind::Group => RenderPass::Overlay,
            },
        })
        .collect();

    RenderGraph {
        document_revision: scene.document_revision,
        dirty,
        passes: vec![
            RenderPass::MainScene,
            RenderPass::Images,
            RenderPass::Text,
            RenderPass::Overlay,
            RenderPass::Composite,
        ],
        commands,
    }
}

/// Concrete native Rust/wgpu executor for the Render Graph's MainScene pass.
///
/// This module is deliberately target-gated: it owns only derived GPU handles
/// and accepts immutable graph/batch data. Canonical Document, Asset bytes and
/// browser/WASM code cannot enter this boundary. Image/Text/Overlay passes use
/// the same graph contract but remain separate executors while their atlas and
/// offscreen resources are completed.
#[cfg(all(feature = "native-wgpu-executor", not(target_arch = "wasm32")))]
pub mod native_executor {
    use std::collections::BTreeMap;

    use super::{GPU_INSTANCE_FLOATS, GpuInstanceBatch, RenderGraph, RenderPass};

    const FLOAT_BYTES: u64 = std::mem::size_of::<f32>() as u64;
    const GLYPH_ATLAS_DIMENSION: u32 = 1024;
    const GLYPH_ATLAS_PADDING: u32 = 1;
    /// Keeps native-derived resources inside the same Phase 1 256 MiB budget
    /// used by the browser transitional scene.
    pub const DEFAULT_NATIVE_GPU_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
    const UNIT_QUAD: [f32; 12] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0];
    const MAIN_SCENE_PASSES: [RenderPass; 5] = [
        RenderPass::MainScene,
        RenderPass::Images,
        RenderPass::Text,
        RenderPass::Overlay,
        RenderPass::Composite,
    ];

    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct WgpuCamera {
        pub viewport_x: f32,
        pub viewport_y: f32,
        pub zoom: f32,
        pub canvas_width: f32,
        pub canvas_height: f32,
        pub dpr: f32,
    }

    impl WgpuCamera {
        fn floats(self) -> [f32; 8] {
            [
                self.viewport_x,
                self.viewport_y,
                self.zoom,
                self.canvas_width,
                self.canvas_height,
                self.dpr,
                0.0,
                0.0,
            ]
        }

        fn is_valid(self) -> bool {
            [
                self.viewport_x,
                self.viewport_y,
                self.zoom,
                self.canvas_width,
                self.canvas_height,
                self.dpr,
            ]
            .into_iter()
            .all(f32::is_finite)
                && self.zoom > 0.0
                && self.canvas_width > 0.0
                && self.canvas_height > 0.0
                && self.dpr > 0.0
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum WgpuExecutorError {
        InvalidCamera,
        InvalidInstanceLayout,
        InvalidRenderPlan,
        InvalidImageInput,
        InvalidTextInput,
        GlyphAtlasFull,
        ResourceBudgetExceeded,
        InvalidOffscreenSurface,
        UnsupportedOffscreenFormat,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct MainSceneExecution {
        pub document_revision: u64,
        pub instance_count: u32,
    }

    /// A transient, already-decoded RGBA8 image. `asset_key` must be derived
    /// from immutable verified content (for example AssetId + content hash), so
    /// a cache hit can never silently substitute different pixels.
    #[derive(Debug, Clone, Copy)]
    pub struct ImagePassInput<'a> {
        pub node_id: u128,
        pub asset_key: &'a str,
        pub bounds: super::Rect,
        pub rotation_degrees: f32,
        pub opacity: f32,
        pub pixel_width: u32,
        pub pixel_height: u32,
        pub rgba8: &'a [u8],
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct ImagePassExecution {
        pub document_revision: u64,
        pub instance_count: u32,
        pub uploaded_assets: u32,
    }

    /// One immutable alpha mask and its display quad. The mask is renderer
    /// cache input only; callers retain FontReference/text rather than pixels.
    #[derive(Debug, Clone, Copy)]
    pub struct TextPassInput<'a> {
        pub node_id: u128,
        pub glyph_key: &'a str,
        pub x: f32,
        pub y: f32,
        pub width: f32,
        pub height: f32,
        pub rotation_degrees: f32,
        pub color_rgba: [f32; 4],
        pub mask_width: u32,
        pub mask_height: u32,
        pub alpha_mask: &'a [u8],
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct TextPassExecution {
        pub document_revision: u64,
        pub glyph_count: u32,
        pub uploaded_glyphs: u32,
    }

    /// Overlay remains a derived presentation layer: selection outlines,
    /// handles and guides are supplied by the platform and never mutate the
    /// Canonical Document. It shares the exact solid primitive contract with
    /// MainScene, but loads rather than clears the accumulated frame.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct OverlayPassExecution {
        pub document_revision: u64,
        pub instance_count: u32,
    }

    /// A completed frame copied from a caller-owned offscreen texture into a
    /// distinct presentation target. The offscreen allocation is intentionally
    /// not owned here yet, so a platform can pool or recreate it independently
    /// without coupling that lifetime to the Canonical Document.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct CompositePassExecution {
        pub document_revision: u64,
    }

    /// Stable dimensions identify a reusable offscreen texture inside one
    /// device generation. They never identify a Canonical resource.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    pub struct OffscreenSurfaceKey {
        pub width: u32,
        pub height: u32,
    }

    /// A cloneable view retained by the caller only for the duration of a
    /// frame. The texture itself remains executor-owned and is accounted for
    /// by the resource budget.
    #[derive(Debug, Clone)]
    pub struct WgpuOffscreenSurface {
        pub key: OffscreenSurfaceKey,
        pub byte_length: u64,
        view: wgpu::TextureView,
    }

    impl WgpuOffscreenSurface {
        pub fn view(&self) -> &wgpu::TextureView {
            &self.view
        }
    }

    /// A real GPU-handle owner. Dropping it drops/reclaims all device-local
    /// buffers and pipelines; callers rebuild from a new immutable Scene after
    /// Device Lost rather than persisting any handle into Canonical state.
    pub struct WgpuExecutor {
        device: wgpu::Device,
        queue: wgpu::Queue,
        pipeline: wgpu::RenderPipeline,
        image_pipeline: wgpu::RenderPipeline,
        text_pipeline: wgpu::RenderPipeline,
        composite_pipeline: wgpu::RenderPipeline,
        unit_quad: wgpu::Buffer,
        camera: wgpu::Buffer,
        camera_bind_group: wgpu::BindGroup,
        instance: Option<wgpu::Buffer>,
        instance_capacity: u64,
        image_instance: Option<wgpu::Buffer>,
        image_instance_capacity: u64,
        image_sampler: wgpu::Sampler,
        image_textures: BTreeMap<String, ImageTexture>,
        text_instance: Option<wgpu::Buffer>,
        text_instance_capacity: u64,
        text_atlas: Option<GlyphAtlasTexture>,
        offscreen_surfaces: BTreeMap<OffscreenSurfaceKey, WgpuOffscreenSurface>,
        target_format: wgpu::TextureFormat,
        max_resource_bytes: u64,
    }

    /// Recreates a clean executor after the platform reports Device Lost. The
    /// adapter and creation settings are intentionally separate from the
    /// executor's derived caches, so a rebuild cannot restore stale buffers,
    /// atlases or Document state. The caller replays the latest Render Graph.
    #[derive(Debug, Clone)]
    pub struct WgpuExecutorFactory {
        adapter: wgpu::Adapter,
        target_format: wgpu::TextureFormat,
        max_resource_bytes: u64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum WgpuExecutorFactoryError {
        RequestDeviceFailed,
    }

    impl WgpuExecutorFactory {
        pub fn new(
            adapter: wgpu::Adapter,
            target_format: wgpu::TextureFormat,
            max_resource_bytes: u64,
        ) -> Self {
            Self {
                adapter,
                target_format,
                max_resource_bytes,
            }
        }

        /// Creates a fresh Device/Queue/executor tuple. Calling this after a
        /// loss is bounded by the host's recovery policy; the factory itself
        /// performs no retry loop.
        pub async fn rebuild(
            &self,
        ) -> Result<(WgpuExecutor, wgpu::Device, wgpu::Queue), WgpuExecutorFactoryError> {
            let (device, queue) = self
                .adapter
                .request_device(&wgpu::DeviceDescriptor::default())
                .await
                .map_err(|_| WgpuExecutorFactoryError::RequestDeviceFailed)?;
            let executor = WgpuExecutor::with_resource_budget(
                device.clone(),
                queue.clone(),
                self.target_format,
                self.max_resource_bytes,
            );
            Ok((executor, device, queue))
        }
    }

    struct ImageTexture {
        width: u32,
        height: u32,
        byte_length: u64,
        _texture: wgpu::Texture,
        bind_group: wgpu::BindGroup,
    }

    #[derive(Clone, Copy)]
    struct GlyphAtlasEntry {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    }

    struct GlyphAtlasTexture {
        texture: wgpu::Texture,
        bind_group: wgpu::BindGroup,
        entries: BTreeMap<String, GlyphAtlasEntry>,
        next_x: u32,
        next_y: u32,
        row_height: u32,
    }

    /// Matches the browser Image Pass `cover` behavior while keeping all image
    /// pixels outside Canonical state. Return value is `(u, v, width, height)`
    /// in normalized source-texture coordinates.
    fn cover_crop_uv(
        source_width: u32,
        source_height: u32,
        target_width: f32,
        target_height: f32,
    ) -> [f32; 4] {
        let source_aspect = source_width as f32 / source_height as f32;
        let target_aspect = target_width / target_height;
        if source_aspect > target_aspect {
            let width = target_aspect / source_aspect;
            [(1.0 - width) * 0.5, 0.0, width, 1.0]
        } else {
            let height = source_aspect / target_aspect;
            [0.0, (1.0 - height) * 0.5, 1.0, height]
        }
    }

    impl WgpuExecutor {
        pub fn new(
            device: wgpu::Device,
            queue: wgpu::Queue,
            target_format: wgpu::TextureFormat,
        ) -> Self {
            Self::with_resource_budget(
                device,
                queue,
                target_format,
                DEFAULT_NATIVE_GPU_RESOURCE_BYTES,
            )
        }

        /// The limit governs only derived executor allocations. It does not
        /// alter graph/document semantics, so a rejected allocation can safely
        /// fall back to Canvas or be rebuilt after Device Lost.
        pub fn with_resource_budget(
            device: wgpu::Device,
            queue: wgpu::Queue,
            target_format: wgpu::TextureFormat,
            max_resource_bytes: u64,
        ) -> Self {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("makefigma-main-scene-wgsl"),
                source: wgpu::ShaderSource::Wgsl(MAIN_SCENE_WGSL.into()),
            });
            let camera_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("makefigma-main-scene-camera-layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("makefigma-main-scene-pipeline-layout"),
                bind_group_layouts: &[Some(&camera_layout)],
                immediate_size: 0,
            });
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("makefigma-main-scene-pipeline"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 2,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &[wgpu::VertexAttribute {
                                format: wgpu::VertexFormat::Float32x2,
                                offset: 0,
                                shader_location: 0,
                            }],
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * GPU_INSTANCE_FLOATS as u64,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: 0,
                                    shader_location: 1,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 4,
                                    shader_location: 2,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 8,
                                    shader_location: 3,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 12,
                                    shader_location: 4,
                                },
                            ],
                        }),
                    ],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
            let image_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("makefigma-image-pass-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
            let image_pipeline_layout =
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("makefigma-image-pass-pipeline-layout"),
                    bind_group_layouts: &[Some(&camera_layout), Some(&image_layout)],
                    immediate_size: 0,
                });
            let image_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("makefigma-image-pass-wgsl"),
                source: wgpu::ShaderSource::Wgsl(IMAGE_PASS_WGSL.into()),
            });
            let image_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("makefigma-image-pass-pipeline"),
                layout: Some(&image_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &image_shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 2,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &[wgpu::VertexAttribute {
                                format: wgpu::VertexFormat::Float32x2,
                                offset: 0,
                                shader_location: 0,
                            }],
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 10,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: 0,
                                    shader_location: 1,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32,
                                    offset: FLOAT_BYTES * 4,
                                    shader_location: 2,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 5,
                                    shader_location: 3,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32,
                                    offset: FLOAT_BYTES * 9,
                                    shader_location: 4,
                                },
                            ],
                        }),
                    ],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &image_shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
            let text_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("makefigma-text-pass-layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
            let text_pipeline_layout =
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("makefigma-text-pass-pipeline-layout"),
                    bind_group_layouts: &[Some(&camera_layout), Some(&text_layout)],
                    immediate_size: 0,
                });
            let text_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("makefigma-text-pass-wgsl"),
                source: wgpu::ShaderSource::Wgsl(TEXT_PASS_WGSL.into()),
            });
            let text_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("makefigma-text-pass-pipeline"),
                layout: Some(&text_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &text_shader,
                    entry_point: Some("vs_main"),
                    compilation_options: Default::default(),
                    buffers: &[
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 2,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &[wgpu::VertexAttribute {
                                format: wgpu::VertexFormat::Float32x2,
                                offset: 0,
                                shader_location: 0,
                            }],
                        }),
                        Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 13,
                            step_mode: wgpu::VertexStepMode::Instance,
                            attributes: &[
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: 0,
                                    shader_location: 1,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32,
                                    offset: FLOAT_BYTES * 4,
                                    shader_location: 2,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 5,
                                    shader_location: 3,
                                },
                                wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x4,
                                    offset: FLOAT_BYTES * 9,
                                    shader_location: 4,
                                },
                            ],
                        }),
                    ],
                },
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &text_shader,
                    entry_point: Some("fs_main"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: target_format,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                multiview_mask: None,
                cache: None,
            });
            let composite_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("makefigma-composite-pass-layout"),
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                    ],
                });
            let composite_pipeline_layout =
                device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("makefigma-composite-pass-pipeline-layout"),
                    bind_group_layouts: &[Some(&composite_layout)],
                    immediate_size: 0,
                });
            let composite_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("makefigma-composite-pass-wgsl"),
                source: wgpu::ShaderSource::Wgsl(COMPOSITE_PASS_WGSL.into()),
            });
            let composite_pipeline =
                device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("makefigma-composite-pass-pipeline"),
                    layout: Some(&composite_pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &composite_shader,
                        entry_point: Some("vs_main"),
                        compilation_options: Default::default(),
                        buffers: &[Some(wgpu::VertexBufferLayout {
                            array_stride: FLOAT_BYTES * 2,
                            step_mode: wgpu::VertexStepMode::Vertex,
                            attributes: &[wgpu::VertexAttribute {
                                format: wgpu::VertexFormat::Float32x2,
                                offset: 0,
                                shader_location: 0,
                            }],
                        })],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &composite_shader,
                        entry_point: Some("fs_main"),
                        compilation_options: Default::default(),
                        targets: &[Some(wgpu::ColorTargetState {
                            format: target_format,
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        })],
                    }),
                    multiview_mask: None,
                    cache: None,
                });
            let image_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("makefigma-image-pass-sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            });
            let unit_quad = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-main-scene-unit-quad"),
                size: (UNIT_QUAD.len() as u64) * FLOAT_BYTES,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            queue.write_buffer(&unit_quad, 0, bytemuck::cast_slice(&UNIT_QUAD));
            let camera = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-main-scene-camera"),
                size: FLOAT_BYTES * 8,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("makefigma-main-scene-camera-bind-group"),
                layout: &camera_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera.as_entire_binding(),
                }],
            });
            Self {
                device,
                queue,
                pipeline,
                image_pipeline,
                text_pipeline,
                composite_pipeline,
                unit_quad,
                camera,
                camera_bind_group,
                instance: None,
                instance_capacity: 0,
                image_instance: None,
                image_instance_capacity: 0,
                image_sampler,
                image_textures: BTreeMap::new(),
                text_instance: None,
                text_instance_capacity: 0,
                text_atlas: None,
                offscreen_surfaces: BTreeMap::new(),
                target_format,
                max_resource_bytes,
            }
        }

        pub fn resource_bytes(&self) -> u64 {
            let base_buffers = (UNIT_QUAD.len() as u64) * FLOAT_BYTES + FLOAT_BYTES * 8;
            let image_textures = self.image_textures.values().fold(0_u64, |total, image| {
                total.saturating_add(image.byte_length)
            });
            let glyph_atlas = if self.text_atlas.is_some() {
                u64::from(GLYPH_ATLAS_DIMENSION) * u64::from(GLYPH_ATLAS_DIMENSION)
            } else {
                0
            };
            let offscreen_surfaces = self
                .offscreen_surfaces
                .values()
                .fold(0_u64, |total, surface| {
                    total.saturating_add(surface.byte_length)
                });
            base_buffers
                .saturating_add(self.instance_capacity)
                .saturating_add(self.image_instance_capacity)
                .saturating_add(self.text_instance_capacity)
                .saturating_add(image_textures)
                .saturating_add(glyph_atlas)
                .saturating_add(offscreen_surfaces)
        }

        /// Allocates or reuses a same-sized offscreen texture suitable for both
        /// Render Pass output and the following Composite texture sample. The
        /// returned view stays valid for the caller's frame while the executor
        /// retains the pooled texture and its budget accounting.
        pub fn acquire_offscreen_surface(
            &mut self,
            key: OffscreenSurfaceKey,
        ) -> Result<WgpuOffscreenSurface, WgpuExecutorError> {
            if key.width == 0
                || key.height == 0
                || key.width > self.device.limits().max_texture_dimension_2d
                || key.height > self.device.limits().max_texture_dimension_2d
            {
                return Err(WgpuExecutorError::InvalidOffscreenSurface);
            }
            if !matches!(
                self.target_format,
                wgpu::TextureFormat::Rgba8Unorm
                    | wgpu::TextureFormat::Rgba8UnormSrgb
                    | wgpu::TextureFormat::Bgra8Unorm
                    | wgpu::TextureFormat::Bgra8UnormSrgb
            ) {
                return Err(WgpuExecutorError::UnsupportedOffscreenFormat);
            }
            if let Some(surface) = self.offscreen_surfaces.get(&key) {
                return Ok(surface.clone());
            }
            let byte_length = u64::from(key.width)
                .checked_mul(u64::from(key.height))
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or(WgpuExecutorError::InvalidOffscreenSurface)?;
            self.ensure_budget(byte_length, 0)?;
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("makefigma-offscreen-surface"),
                size: wgpu::Extent3d {
                    width: key.width,
                    height: key.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: self.target_format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let surface = WgpuOffscreenSurface {
                key,
                byte_length,
                view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
            };
            self.offscreen_surfaces.insert(key, surface.clone());
            Ok(surface)
        }

        /// Releases a pooled offscreen texture once no presentation frame still
        /// references its returned view. This only frees derived GPU state.
        pub fn release_offscreen_surface(&mut self, key: OffscreenSurfaceKey) -> bool {
            self.offscreen_surfaces.remove(&key).is_some()
        }

        /// Encodes and submits the graph's MainScene pass. The caller retains
        /// the surface/texture lifecycle; this executor cannot mutate it.
        pub fn execute_main_scene(
            &mut self,
            graph: &RenderGraph,
            batch: &GpuInstanceBatch,
            camera: WgpuCamera,
            target: &wgpu::TextureView,
        ) -> Result<MainSceneExecution, WgpuExecutorError> {
            if graph.passes != MAIN_SCENE_PASSES {
                return Err(WgpuExecutorError::InvalidRenderPlan);
            }
            if !camera.is_valid() {
                return Err(WgpuExecutorError::InvalidCamera);
            }
            if batch.instance_floats.len() % GPU_INSTANCE_FLOATS != 0 {
                return Err(WgpuExecutorError::InvalidInstanceLayout);
            }
            let instance_count = (batch.instance_floats.len() / GPU_INSTANCE_FLOATS) as u32;
            self.queue
                .write_buffer(&self.camera, 0, bytemuck::cast_slice(&camera.floats()));
            if instance_count > 0 {
                self.ensure_instance_buffer(batch.instance_floats.len() as u64 * FLOAT_BYTES)?;
                self.queue.write_buffer(
                    self.instance.as_ref().expect("allocated above"),
                    0,
                    bytemuck::cast_slice(&batch.instance_floats),
                );
            }
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("makefigma-main-scene-encoder"),
                });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("makefigma-main-scene-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                if instance_count > 0 {
                    pass.set_pipeline(&self.pipeline);
                    pass.set_bind_group(0, &self.camera_bind_group, &[]);
                    pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                    pass.set_vertex_buffer(
                        1,
                        self.instance.as_ref().expect("allocated above").slice(..),
                    );
                    pass.draw(0..6, 0..instance_count);
                }
            }
            self.queue.submit(Some(encoder.finish()));
            Ok(MainSceneExecution {
                document_revision: graph.document_revision,
                instance_count,
            })
        }

        /// Draws verified decoded RGBA resources above MainScene without
        /// clearing the target. The caller invokes this after `execute_main_scene`
        /// and before Text/Overlay, preserving the graph's fixed pass order.
        pub fn execute_image_pass(
            &mut self,
            graph: &RenderGraph,
            images: &[ImagePassInput<'_>],
            camera: WgpuCamera,
            target: &wgpu::TextureView,
        ) -> Result<ImagePassExecution, WgpuExecutorError> {
            if graph.passes != MAIN_SCENE_PASSES {
                return Err(WgpuExecutorError::InvalidRenderPlan);
            }
            if !camera.is_valid() {
                return Err(WgpuExecutorError::InvalidCamera);
            }
            self.queue
                .write_buffer(&self.camera, 0, bytemuck::cast_slice(&camera.floats()));
            let mut instance_data = Vec::with_capacity(images.len() * 10);
            let mut keys = Vec::with_capacity(images.len());
            let mut uploaded_assets = 0;
            for image in images {
                if self.ensure_image_texture(image)? {
                    uploaded_assets += 1;
                }
                let uv = cover_crop_uv(
                    image.pixel_width,
                    image.pixel_height,
                    image.bounds.width,
                    image.bounds.height,
                );
                instance_data.extend_from_slice(&[
                    image.bounds.x,
                    image.bounds.y,
                    image.bounds.width,
                    image.bounds.height,
                    image.rotation_degrees,
                    uv[0],
                    uv[1],
                    uv[2],
                    uv[3],
                    image.opacity,
                ]);
                keys.push(image.asset_key);
            }
            self.image_textures
                .retain(|key, _| keys.iter().any(|active| *active == key));
            let instance_count = images.len() as u32;
            if instance_count == 0 {
                return Ok(ImagePassExecution {
                    document_revision: graph.document_revision,
                    instance_count,
                    uploaded_assets,
                });
            }
            self.ensure_image_instance_buffer(instance_data.len() as u64 * FLOAT_BYTES)?;
            self.queue.write_buffer(
                self.image_instance.as_ref().expect("allocated above"),
                0,
                bytemuck::cast_slice(&instance_data),
            );
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("makefigma-image-pass-encoder"),
                });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("makefigma-image-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.image_pipeline);
                pass.set_bind_group(0, &self.camera_bind_group, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                for (index, key) in keys.iter().enumerate() {
                    let entry = self.image_textures.get(*key).expect("admitted above");
                    pass.set_bind_group(1, &entry.bind_group, &[]);
                    pass.set_vertex_buffer(
                        1,
                        self.image_instance
                            .as_ref()
                            .expect("allocated above")
                            .slice(
                                (index as u64 * FLOAT_BYTES * 10)
                                    ..((index as u64 + 1) * FLOAT_BYTES * 10),
                            ),
                    );
                    pass.draw(0..6, 0..1);
                }
            }
            self.queue.submit(Some(encoder.finish()));
            Ok(ImagePassExecution {
                document_revision: graph.document_revision,
                instance_count,
                uploaded_assets,
            })
        }

        /// Draws the glyph atlas above images without clearing the target.
        /// Atlas entries are derived resources and are discarded with this
        /// executor/device generation; no placement enters Canonical state.
        pub fn execute_text_pass(
            &mut self,
            graph: &RenderGraph,
            glyphs: &[TextPassInput<'_>],
            camera: WgpuCamera,
            target: &wgpu::TextureView,
        ) -> Result<TextPassExecution, WgpuExecutorError> {
            if graph.passes != MAIN_SCENE_PASSES {
                return Err(WgpuExecutorError::InvalidRenderPlan);
            }
            if !camera.is_valid() {
                return Err(WgpuExecutorError::InvalidCamera);
            }
            self.queue
                .write_buffer(&self.camera, 0, bytemuck::cast_slice(&camera.floats()));
            let mut instances = Vec::with_capacity(glyphs.len() * 13);
            let mut uploaded_glyphs = 0;
            for glyph in glyphs {
                let (entry, uploaded) = self.ensure_glyph_atlas_entry(glyph)?;
                if uploaded {
                    uploaded_glyphs += 1;
                }
                instances.extend_from_slice(&[
                    glyph.x,
                    glyph.y,
                    glyph.width,
                    glyph.height,
                    glyph.rotation_degrees,
                    glyph.color_rgba[0],
                    glyph.color_rgba[1],
                    glyph.color_rgba[2],
                    glyph.color_rgba[3],
                    entry.x as f32 / GLYPH_ATLAS_DIMENSION as f32,
                    entry.y as f32 / GLYPH_ATLAS_DIMENSION as f32,
                    entry.width as f32 / GLYPH_ATLAS_DIMENSION as f32,
                    entry.height as f32 / GLYPH_ATLAS_DIMENSION as f32,
                ]);
            }
            let glyph_count = glyphs.len() as u32;
            if glyph_count == 0 {
                return Ok(TextPassExecution {
                    document_revision: graph.document_revision,
                    glyph_count,
                    uploaded_glyphs,
                });
            }
            self.ensure_text_instance_buffer(instances.len() as u64 * FLOAT_BYTES)?;
            self.queue.write_buffer(
                self.text_instance.as_ref().expect("allocated above"),
                0,
                bytemuck::cast_slice(&instances),
            );
            let atlas = self.text_atlas.as_ref().expect("glyphs allocate atlas");
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("makefigma-text-pass-encoder"),
                });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("makefigma-text-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.text_pipeline);
                pass.set_bind_group(0, &self.camera_bind_group, &[]);
                pass.set_bind_group(1, &atlas.bind_group, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                pass.set_vertex_buffer(
                    1,
                    self.text_instance
                        .as_ref()
                        .expect("allocated above")
                        .slice(..),
                );
                pass.draw(0..6, 0..glyph_count);
            }
            self.queue.submit(Some(encoder.finish()));
            Ok(TextPassExecution {
                document_revision: graph.document_revision,
                glyph_count,
                uploaded_glyphs,
            })
        }

        /// Draws transient selection and guide primitives above text without
        /// clearing the current frame. Overlay input follows the same stable
        /// 16-float contract as MainScene, while the caller owns the ephemeral
        /// interaction state that produced it.
        pub fn execute_overlay_pass(
            &mut self,
            graph: &RenderGraph,
            batch: &GpuInstanceBatch,
            camera: WgpuCamera,
            target: &wgpu::TextureView,
        ) -> Result<OverlayPassExecution, WgpuExecutorError> {
            if graph.passes != MAIN_SCENE_PASSES {
                return Err(WgpuExecutorError::InvalidRenderPlan);
            }
            if !camera.is_valid() {
                return Err(WgpuExecutorError::InvalidCamera);
            }
            if batch.instance_floats.len() % GPU_INSTANCE_FLOATS != 0 {
                return Err(WgpuExecutorError::InvalidInstanceLayout);
            }
            let instance_count = (batch.instance_floats.len() / GPU_INSTANCE_FLOATS) as u32;
            if instance_count == 0 {
                return Ok(OverlayPassExecution {
                    document_revision: graph.document_revision,
                    instance_count,
                });
            }
            self.queue
                .write_buffer(&self.camera, 0, bytemuck::cast_slice(&camera.floats()));
            self.ensure_instance_buffer(batch.instance_floats.len() as u64 * FLOAT_BYTES)?;
            self.queue.write_buffer(
                self.instance.as_ref().expect("allocated above"),
                0,
                bytemuck::cast_slice(&batch.instance_floats),
            );
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("makefigma-overlay-pass-encoder"),
                });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("makefigma-overlay-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.camera_bind_group, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                pass.set_vertex_buffer(
                    1,
                    self.instance.as_ref().expect("allocated above").slice(..),
                );
                pass.draw(0..6, 0..instance_count);
            }
            self.queue.submit(Some(encoder.finish()));
            Ok(OverlayPassExecution {
                document_revision: graph.document_revision,
                instance_count,
            })
        }

        /// Composites a completed, filterable source view into a distinct
        /// caller-owned target. The source must not alias `target`; this method
        /// owns neither texture, so device-loss recovery can discard and rebuild
        /// both from the current immutable Scene.
        pub fn execute_composite_pass(
            &mut self,
            graph: &RenderGraph,
            source: &wgpu::TextureView,
            target: &wgpu::TextureView,
        ) -> Result<CompositePassExecution, WgpuExecutorError> {
            if graph.passes != MAIN_SCENE_PASSES {
                return Err(WgpuExecutorError::InvalidRenderPlan);
            }
            let source_bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("makefigma-composite-pass-source-bind-group"),
                layout: &self.composite_pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(source),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.image_sampler),
                    },
                ],
            });
            let mut encoder = self
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("makefigma-composite-pass-encoder"),
                });
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("makefigma-composite-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                pass.set_pipeline(&self.composite_pipeline);
                pass.set_bind_group(0, &source_bind_group, &[]);
                pass.set_vertex_buffer(0, self.unit_quad.slice(..));
                pass.draw(0..6, 0..1);
            }
            self.queue.submit(Some(encoder.finish()));
            Ok(CompositePassExecution {
                document_revision: graph.document_revision,
            })
        }

        fn ensure_instance_buffer(&mut self, required: u64) -> Result<(), WgpuExecutorError> {
            if self.instance_capacity >= required {
                return Ok(());
            }
            let next_capacity = required.max(4 * 1024);
            self.ensure_budget(next_capacity, self.instance_capacity)?;
            self.instance_capacity = next_capacity;
            self.instance = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-main-scene-instances"),
                size: self.instance_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            Ok(())
        }

        fn ensure_image_instance_buffer(&mut self, required: u64) -> Result<(), WgpuExecutorError> {
            if self.image_instance_capacity >= required {
                return Ok(());
            }
            let next_capacity = required.max(4 * 1024);
            self.ensure_budget(next_capacity, self.image_instance_capacity)?;
            self.image_instance_capacity = next_capacity;
            self.image_instance = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-image-pass-instances"),
                size: self.image_instance_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            Ok(())
        }

        fn ensure_text_instance_buffer(&mut self, required: u64) -> Result<(), WgpuExecutorError> {
            if self.text_instance_capacity >= required {
                return Ok(());
            }
            let next_capacity = required.max(4 * 1024);
            self.ensure_budget(next_capacity, self.text_instance_capacity)?;
            self.text_instance_capacity = next_capacity;
            self.text_instance = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-text-pass-instances"),
                size: self.text_instance_capacity,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
            Ok(())
        }

        fn ensure_budget(&self, incoming: u64, replacing: u64) -> Result<(), WgpuExecutorError> {
            let next = self
                .resource_bytes()
                .saturating_sub(replacing)
                .saturating_add(incoming);
            if next > self.max_resource_bytes {
                return Err(WgpuExecutorError::ResourceBudgetExceeded);
            }
            Ok(())
        }

        fn ensure_glyph_atlas_entry(
            &mut self,
            glyph: &TextPassInput<'_>,
        ) -> Result<(GlyphAtlasEntry, bool), WgpuExecutorError> {
            let expected_len = usize::try_from(glyph.mask_width).ok().and_then(|width| {
                usize::try_from(glyph.mask_height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            });
            if glyph.glyph_key.is_empty()
                || glyph.mask_width == 0
                || glyph.mask_height == 0
                || glyph.width <= 0.0
                || glyph.height <= 0.0
                || expected_len != Some(glyph.alpha_mask.len())
                || ![
                    glyph.x,
                    glyph.y,
                    glyph.width,
                    glyph.height,
                    glyph.rotation_degrees,
                ]
                .into_iter()
                .all(f32::is_finite)
                || !glyph
                    .color_rgba
                    .into_iter()
                    .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
            {
                return Err(WgpuExecutorError::InvalidTextInput);
            }
            if self.text_atlas.is_none() {
                self.ensure_budget(
                    u64::from(GLYPH_ATLAS_DIMENSION) * u64::from(GLYPH_ATLAS_DIMENSION),
                    0,
                )?;
                self.text_atlas = Some(self.create_glyph_atlas());
            }
            let atlas = self.text_atlas.as_mut().expect("created above");
            if let Some(entry) = atlas.entries.get(glyph.glyph_key) {
                if entry.width == glyph.mask_width && entry.height == glyph.mask_height {
                    return Ok((*entry, false));
                }
                return Err(WgpuExecutorError::InvalidTextInput);
            }
            let allocated_width = glyph
                .mask_width
                .checked_add(GLYPH_ATLAS_PADDING * 2)
                .ok_or(WgpuExecutorError::GlyphAtlasFull)?;
            let allocated_height = glyph
                .mask_height
                .checked_add(GLYPH_ATLAS_PADDING * 2)
                .ok_or(WgpuExecutorError::GlyphAtlasFull)?;
            if allocated_width > GLYPH_ATLAS_DIMENSION || allocated_height > GLYPH_ATLAS_DIMENSION {
                return Err(WgpuExecutorError::GlyphAtlasFull);
            }
            if atlas.next_x + allocated_width > GLYPH_ATLAS_DIMENSION {
                atlas.next_x = 0;
                atlas.next_y = atlas.next_y.saturating_add(atlas.row_height);
                atlas.row_height = 0;
            }
            if atlas.next_y + allocated_height > GLYPH_ATLAS_DIMENSION {
                return Err(WgpuExecutorError::GlyphAtlasFull);
            }
            let entry = GlyphAtlasEntry {
                x: atlas.next_x + GLYPH_ATLAS_PADDING,
                y: atlas.next_y + GLYPH_ATLAS_PADDING,
                width: glyph.mask_width,
                height: glyph.mask_height,
            };
            atlas.next_x += allocated_width;
            atlas.row_height = atlas.row_height.max(allocated_height);
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &atlas.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: entry.x,
                        y: entry.y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                glyph.alpha_mask,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(glyph.mask_width),
                    rows_per_image: Some(glyph.mask_height),
                },
                wgpu::Extent3d {
                    width: glyph.mask_width,
                    height: glyph.mask_height,
                    depth_or_array_layers: 1,
                },
            );
            atlas.entries.insert(glyph.glyph_key.to_owned(), entry);
            Ok((entry, true))
        }

        fn create_glyph_atlas(&self) -> GlyphAtlasTexture {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("makefigma-text-glyph-atlas"),
                size: wgpu::Extent3d {
                    width: GLYPH_ATLAS_DIMENSION,
                    height: GLYPH_ATLAS_DIMENSION,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R8Unorm,
                usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("makefigma-text-glyph-atlas-bind-group"),
                layout: &self.text_pipeline.get_bind_group_layout(1),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.image_sampler),
                    },
                ],
            });
            GlyphAtlasTexture {
                texture,
                bind_group,
                entries: BTreeMap::new(),
                next_x: 0,
                next_y: 0,
                row_height: 0,
            }
        }

        /// Returns true only when a new GPU texture upload was required.
        fn ensure_image_texture(
            &mut self,
            image: &ImagePassInput<'_>,
        ) -> Result<bool, WgpuExecutorError> {
            let expected_len = usize::try_from(image.pixel_width)
                .ok()
                .and_then(|width| {
                    usize::try_from(image.pixel_height)
                        .ok()
                        .and_then(|height| width.checked_mul(height))
                })
                .and_then(|pixels| pixels.checked_mul(4));
            if image.asset_key.is_empty()
                || image.pixel_width == 0
                || image.pixel_height == 0
                || expected_len != Some(image.rgba8.len())
                || ![
                    image.bounds.x,
                    image.bounds.y,
                    image.bounds.width,
                    image.bounds.height,
                    image.rotation_degrees,
                    image.opacity,
                ]
                .into_iter()
                .all(f32::is_finite)
                || image.bounds.width <= 0.0
                || image.bounds.height <= 0.0
                || image.opacity < 0.0
                || image.opacity > 1.0
            {
                return Err(WgpuExecutorError::InvalidImageInput);
            }
            if let Some(existing) = self.image_textures.get(image.asset_key) {
                if existing.width == image.pixel_width && existing.height == image.pixel_height {
                    return Ok(false);
                }
            }
            let byte_length = u64::from(image.pixel_width)
                .checked_mul(u64::from(image.pixel_height))
                .and_then(|pixels| pixels.checked_mul(4))
                .ok_or(WgpuExecutorError::InvalidImageInput)?;
            let replacing = self
                .image_textures
                .get(image.asset_key)
                .map(|entry| entry.byte_length)
                .unwrap_or(0);
            self.ensure_budget(byte_length, replacing)?;
            self.image_textures.remove(image.asset_key);
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("makefigma-image-pass-texture"),
                size: wgpu::Extent3d {
                    width: image.pixel_width,
                    height: image.pixel_height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                image.rgba8,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(image.pixel_width * 4),
                    rows_per_image: Some(image.pixel_height),
                },
                wgpu::Extent3d {
                    width: image.pixel_width,
                    height: image.pixel_height,
                    depth_or_array_layers: 1,
                },
            );
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("makefigma-image-pass-bind-group"),
                layout: &self.image_pipeline.get_bind_group_layout(1),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(
                            &texture.create_view(&wgpu::TextureViewDescriptor::default()),
                        ),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.image_sampler),
                    },
                ],
            });
            self.image_textures.insert(
                image.asset_key.to_owned(),
                ImageTexture {
                    width: image.pixel_width,
                    height: image.pixel_height,
                    byte_length,
                    _texture: texture,
                    bind_group,
                },
            );
            Ok(true)
        }
    }

    const MAIN_SCENE_WGSL: &str = r#"
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
struct Input {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_params: vec4<f32>, @location(3) fill: vec4<f32>, @location(4) stroke: vec4<f32>,
};
struct Output {
  @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>,
  @location(1) fill: vec4<f32>, @location(2) stroke: vec4<f32>, @location(3) params: vec4<f32>,
};
@vertex fn vs_main(input: Input) -> Output {
  var output: Output;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_params.x * 0.01745329252;
  let point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(point.x * cos(radians) - point.y * sin(radians), point.x * sin(radians) + point.y * cos(radians));
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  let smallest = max(1.0, min(abs(size.x), abs(size.y)));
  output.local = input.local;
  output.fill = input.fill;
  output.stroke = input.stroke;
  output.params = vec4<f32>(input.rotation_params.y, input.rotation_params.z / smallest, input.rotation_params.w / smallest, abs(size.x) / max(1.0, abs(size.y)));
  return output;
}
fn rounded_box_distance(point: vec2<f32>, half_extent: vec2<f32>, radius: f32) -> f32 {
  let q = abs(point) - (half_extent - vec2<f32>(radius));
  return length(max(q, vec2<f32>(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  if (input.params.x > 0.5) {
    let aspect = max(input.params.w, 0.0001);
    let extent = select(vec2<f32>(1.0, 1.0 / aspect), vec2<f32>(aspect, 1.0), aspect >= 1.0);
    let outer_half_extent = extent * 0.5;
    let point = (input.local - vec2<f32>(0.5)) * extent;
    let outer_distance = length(point / outer_half_extent) - 1.0;
    if (outer_distance > 0.0) { discard; }
    if (input.params.z > 0.0) {
      let inner_half_extent = max(outer_half_extent - vec2<f32>(input.params.z), vec2<f32>(0.0001));
      let inner_distance = length(point / inner_half_extent) - 1.0;
      if (inner_distance > 0.0) { return input.stroke; }
    }
    return input.fill;
  }
  let aspect = max(input.params.w, 0.0001);
  let scale = select(vec2<f32>(1.0, 1.0 / aspect), vec2<f32>(aspect, 1.0), aspect >= 1.0);
  let distance = rounded_box_distance((input.local - vec2<f32>(0.5)) * scale, vec2<f32>(0.5) * scale, min(input.params.y, 0.5));
  if (distance > 0.0) { discard; }
  if (input.params.z > 0.0 && distance > -input.params.z) { return input.stroke; }
  return input.fill;
}
"#;

    const IMAGE_PASS_WGSL: &str = r#"
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var image_texture: texture_2d<f32>;
@group(1) @binding(1) var image_sampler: sampler;
struct Input {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_degrees: f32, @location(3) uv_rect: vec4<f32>, @location(4) opacity: f32,
};
struct Output { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) opacity: f32, };
@vertex fn vs_main(input: Input) -> Output {
  var output: Output;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_degrees * 0.01745329252;
  let point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(point.x * cos(radians) - point.y * sin(radians), point.x * sin(radians) + point.y * cos(radians));
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  output.uv = input.uv_rect.xy + input.local * input.uv_rect.zw;
  output.opacity = input.opacity;
  return output;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let sample = textureSample(image_texture, image_sampler, input.uv);
  return vec4<f32>(sample.rgb, sample.a * input.opacity);
}
"#;

    const TEXT_PASS_WGSL: &str = r#"
struct Camera { first: vec4<f32>, second: vec4<f32>, };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var glyph_mask: texture_2d<f32>;
@group(1) @binding(1) var glyph_sampler: sampler;
struct Input {
  @location(0) local: vec2<f32>, @location(1) position_size: vec4<f32>,
  @location(2) rotation_degrees: f32, @location(3) color: vec4<f32>, @location(4) atlas_uv_rect: vec4<f32>,
};
struct Output { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec4<f32>, };
@vertex fn vs_main(input: Input) -> Output {
  var output: Output;
  let size = input.position_size.zw;
  let center = size * 0.5;
  let radians = input.rotation_degrees * 0.01745329252;
  let point = input.local * size - center;
  let world = input.position_size.xy + center + vec2<f32>(point.x * cos(radians) - point.y * sin(radians), point.x * sin(radians) + point.y * cos(radians));
  let screen = (world + camera.first.xy) * camera.first.z + vec2<f32>(camera.first.w * 0.5, camera.second.x * 0.5);
  output.position = vec4<f32>(screen.x / camera.first.w * 2.0 - 1.0, 1.0 - screen.y / camera.second.x * 2.0, 0.0, 1.0);
  output.uv = input.atlas_uv_rect.xy + input.local * input.atlas_uv_rect.zw;
  output.color = input.color;
  return output;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let alpha = textureSample(glyph_mask, glyph_sampler, input.uv).r * input.color.a;
  return vec4<f32>(input.color.rgb, alpha);
}
"#;

    const COMPOSITE_PASS_WGSL: &str = r#"
@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
struct Input { @location(0) local: vec2<f32>, };
struct Output { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32>, };
@vertex fn vs_main(input: Input) -> Output {
  var output: Output;
  output.position = vec4<f32>(input.local.x * 2.0 - 1.0, 1.0 - input.local.y * 2.0, 0.0, 1.0);
  output.uv = input.local;
  return output;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  return textureSample(source_texture, source_sampler, input.uv);
}
"#;

    #[cfg(test)]
    mod tests {
        use std::{sync::mpsc, time::Duration};

        use super::{
            ImagePassInput, OffscreenSurfaceKey, TextPassInput, WgpuCamera, WgpuExecutor,
            WgpuExecutorError, WgpuExecutorFactory, cover_crop_uv,
        };
        use crate::{
            DirtySet, GpuPrimitive, Rect, Scene, SceneNode, SceneNodeKind,
            build_gpu_instance_batch, compile_render_graph,
        };

        #[test]
        fn cover_crop_matches_the_source_and_target_aspect_ratio() {
            assert_eq!(cover_crop_uv(200, 100, 100.0, 100.0), [0.25, 0.0, 0.5, 1.0]);
            assert_eq!(cover_crop_uv(100, 200, 100.0, 100.0), [0.0, 0.25, 1.0, 0.5]);
            assert_eq!(cover_crop_uv(200, 100, 400.0, 200.0), [0.0, 0.0, 1.0, 1.0]);
        }

        #[test]
        fn headless_device_accepts_and_submits_the_main_scene_pass_when_available() {
            let instance =
                wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
            let Ok(adapter) = pollster::block_on(
                instance.request_adapter(&wgpu::RequestAdapterOptions::default()),
            ) else {
                // Headless Linux CI may deliberately omit every GPU backend.
                return;
            };
            let factory = WgpuExecutorFactory::new(
                adapter,
                wgpu::TextureFormat::Rgba8Unorm,
                256 * 1024 * 1024,
            );
            let Ok((mut executor, device, queue)) = pollster::block_on(factory.rebuild()) else {
                return;
            };
            let composited_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("makefigma-native-executor-test-composite-target"),
                size: wgpu::Extent3d {
                    width: 64,
                    height: 64,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let composited_view =
                composited_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let scene = Scene {
                document_revision: 7,
                nodes: vec![SceneNode {
                    id: 11,
                    kind: SceneNodeKind::Rectangle,
                    bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 20.0,
                        height: 20.0,
                    },
                    z_index: 0,
                }],
            };
            let graph = compile_render_graph(
                &scene,
                DirtySet::full_scene(7),
                Rect {
                    x: -1.0,
                    y: -1.0,
                    width: 40.0,
                    height: 40.0,
                },
            );
            let batch = build_gpu_instance_batch([GpuPrimitive {
                node_id: 11,
                kind: SceneNodeKind::Rectangle,
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                rotation_degrees: 0.0,
                corner_radius: 0.0,
                stroke_width: 0.0,
                shape_stroke_outset: 0.0,
                fill_rgba: [1.0, 0.0, 0.0, 1.0],
                stroke_rgba: [0.0; 4],
            }]);
            let error_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let offscreen_key = OffscreenSurfaceKey {
                width: 64,
                height: 64,
            };
            let offscreen = executor.acquire_offscreen_surface(offscreen_key).unwrap();
            let resource_bytes_after_first_surface = executor.resource_bytes();
            let reused_offscreen = executor.acquire_offscreen_surface(offscreen_key).unwrap();
            assert_eq!(reused_offscreen.key, offscreen_key);
            assert_eq!(
                executor.resource_bytes(),
                resource_bytes_after_first_surface
            );
            let view = offscreen.view();
            let result = executor.execute_main_scene(
                &graph,
                &batch,
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(result.unwrap().instance_count, 1);
            let image = ImagePassInput {
                node_id: 12,
                asset_key: "asset-blue-v1",
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                rotation_degrees: 0.0,
                opacity: 1.0,
                pixel_width: 1,
                pixel_height: 1,
                rgba8: &[0, 0, 255, 255],
            };
            let image_result = executor.execute_image_pass(
                &graph,
                &[image],
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(image_result.unwrap().uploaded_assets, 1);
            let cached_image_result = executor.execute_image_pass(
                &graph,
                &[image],
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(cached_image_result.unwrap().uploaded_assets, 0);
            let glyph = TextPassInput {
                node_id: 13,
                glyph_key: "font-a:1:16",
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
                rotation_degrees: 0.0,
                color_rgba: [0.0, 1.0, 0.0, 1.0],
                mask_width: 2,
                mask_height: 2,
                alpha_mask: &[255, 255, 255, 255],
            };
            let text_result = executor.execute_text_pass(
                &graph,
                &[glyph],
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(text_result.unwrap().uploaded_glyphs, 1);
            let cached_text_result = executor.execute_text_pass(
                &graph,
                &[glyph],
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(cached_text_result.unwrap().uploaded_glyphs, 0);
            let overlay_batch = build_gpu_instance_batch([GpuPrimitive {
                node_id: 14,
                kind: SceneNodeKind::Rectangle,
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                rotation_degrees: 0.0,
                corner_radius: 0.0,
                stroke_width: 0.0,
                shape_stroke_outset: 0.0,
                fill_rgba: [1.0, 1.0, 0.0, 1.0],
                stroke_rgba: [0.0; 4],
            }]);
            let overlay_result = executor.execute_overlay_pass(
                &graph,
                &overlay_batch,
                WgpuCamera {
                    viewport_x: 0.0,
                    viewport_y: 0.0,
                    zoom: 1.0,
                    canvas_width: 64.0,
                    canvas_height: 64.0,
                    dpr: 1.0,
                },
                &view,
            );
            assert_eq!(overlay_result.unwrap().instance_count, 1);
            assert_eq!(
                executor
                    .execute_composite_pass(&graph, &view, &composited_view)
                    .unwrap()
                    .document_revision,
                7,
            );
            let mut constrained = WgpuExecutor::with_resource_budget(
                device.clone(),
                queue.clone(),
                wgpu::TextureFormat::Rgba8Unorm,
                16 * 1024,
            );
            assert_eq!(
                constrained.execute_text_pass(
                    &graph,
                    &[glyph],
                    WgpuCamera {
                        viewport_x: 0.0,
                        viewport_y: 0.0,
                        zoom: 1.0,
                        canvas_width: 64.0,
                        canvas_height: 64.0,
                        dpr: 1.0
                    },
                    &view,
                ),
                Err(WgpuExecutorError::ResourceBudgetExceeded),
            );
            assert!(constrained.resource_bytes() < 16 * 1024);
            let resource_bytes_before_release = executor.resource_bytes();
            assert!(executor.release_offscreen_surface(offscreen_key));
            assert_eq!(
                executor.resource_bytes(),
                resource_bytes_before_release
                    - u64::from(offscreen_key.width) * u64::from(offscreen_key.height) * 4,
            );
            assert!(!executor.release_offscreen_surface(offscreen_key));
            let bytes_per_row = 256;
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("makefigma-native-executor-test-readback"),
                size: u64::from(bytes_per_row * 64),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("makefigma-native-executor-test-readback-encoder"),
            });
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: &composited_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(bytes_per_row),
                        rows_per_image: Some(64),
                    },
                },
                wgpu::Extent3d {
                    width: 64,
                    height: 64,
                    depth_or_array_layers: 1,
                },
            );
            queue.submit(Some(encoder.finish()));
            let slice = readback.slice(..);
            let (sender, receiver) = mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |result| {
                sender.send(result).unwrap()
            });
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(Duration::from_secs(5)),
                })
                .unwrap();
            receiver.recv().unwrap().unwrap();
            let pixels = slice.get_mapped_range().unwrap();
            let center = 42 * bytes_per_row as usize + 42 * 4;
            // MainScene → Image → Text → Overlay uses Load at each subsequent
            // pass. Composite then copies the transient yellow overlay and all
            // prior layers into an independent output texture.
            assert_eq!(&pixels[center..center + 4], &[255, 255, 0, 255]);
            drop(pixels);
            readback.unmap();
            assert!(pollster::block_on(error_scope.pop()).is_none());
            let rebuilt = pollster::block_on(factory.rebuild()).unwrap().0;
            assert_eq!(
                rebuilt.resource_bytes(),
                (12 + 8) * std::mem::size_of::<f32>() as u64
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DeviceState, DirtySet, GPU_INSTANCE_FLOATS, GpuPrimitive, GpuResourceDescriptor,
        GpuResourceError, GpuResourceKind, GpuResourcePool, Rect, RenderCommand, RenderPass, Scene,
        SceneNode, SceneNodeKind, build_gpu_instance_batch, compile_render_graph,
    };

    fn node(id: u128, kind: SceneNodeKind, z_index: u32, x: f32) -> SceneNode {
        SceneNode {
            id,
            kind,
            bounds: Rect {
                x,
                y: 0.0,
                width: 10.0,
                height: 10.0,
            },
            z_index,
        }
    }

    #[test]
    fn compiles_current_visible_nodes_in_stable_pass_and_z_order() {
        let scene = Scene {
            document_revision: 8,
            nodes: vec![
                node(4, SceneNodeKind::Text, 2, 0.0),
                node(2, SceneNodeKind::Image, 1, 0.0),
                node(1, SceneNodeKind::Rectangle, 0, 0.0),
                node(99, SceneNodeKind::Ellipse, 3, 99.0),
            ],
        };
        let graph = compile_render_graph(
            &scene,
            DirtySet::nodes(8, [1, 2, 4]),
            Rect {
                x: 0.0,
                y: 0.0,
                width: 30.0,
                height: 30.0,
            },
        );
        assert_eq!(
            graph.passes,
            vec![
                RenderPass::MainScene,
                RenderPass::Images,
                RenderPass::Text,
                RenderPass::Overlay,
                RenderPass::Composite,
            ]
        );
        assert_eq!(
            graph.commands,
            vec![
                RenderCommand {
                    node_id: 1,
                    pass: RenderPass::MainScene,
                },
                RenderCommand {
                    node_id: 2,
                    pass: RenderPass::Images,
                },
                RenderCommand {
                    node_id: 4,
                    pass: RenderPass::Text,
                },
            ]
        );
    }

    #[test]
    fn graph_records_current_revision_instead_of_any_gpu_cache_generation() {
        let scene = Scene {
            document_revision: 12,
            nodes: vec![node(7, SceneNodeKind::Frame, 0, 0.0)],
        };
        let graph = compile_render_graph(
            &scene,
            DirtySet::full_scene(12),
            Rect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
        );
        assert_eq!(graph.document_revision, 12);
        assert!(graph.dirty.full_scene);
        assert_eq!(graph.commands[0].node_id, 7);
    }

    #[test]
    fn resource_budget_rejects_without_eviction_and_device_loss_rebuilds_once() {
        let mut pool = GpuResourcePool::new(100);
        pool.admit(GpuResourceDescriptor {
            id: 1,
            kind: GpuResourceKind::GlyphAtlas,
            byte_length: 60,
        })
        .unwrap();
        assert_eq!(
            pool.admit(GpuResourceDescriptor {
                id: 2,
                kind: GpuResourceKind::ImageAtlas,
                byte_length: 50,
            }),
            Err(GpuResourceError::BudgetExceeded)
        );
        assert_eq!(pool.used_bytes(), 60);

        let first = pool.device_lost();
        assert_eq!(first.state, DeviceState::Recovering);
        assert_eq!(first.invalidated_resources, 1);
        assert_eq!(pool.used_bytes(), 0);
        pool.finish_rebuild();
        assert_eq!(pool.state(), DeviceState::Ready);
        assert_eq!(pool.device_lost().state, DeviceState::CanvasFallback);
    }

    #[test]
    fn solid_instance_batch_excludes_text_and_keeps_the_wgsl_layout_stable() {
        let batch = build_gpu_instance_batch([
            GpuPrimitive {
                node_id: 1,
                kind: SceneNodeKind::Rectangle,
                bounds: Rect {
                    x: 2.0,
                    y: 3.0,
                    width: 40.0,
                    height: 20.0,
                },
                rotation_degrees: 15.0,
                corner_radius: 99.0,
                stroke_width: 3.0,
                shape_stroke_outset: 0.0,
                fill_rgba: [0.1, 0.2, 0.3, 1.0],
                stroke_rgba: [0.4, 0.5, 0.6, 1.0],
            },
            GpuPrimitive {
                node_id: 2,
                kind: SceneNodeKind::Text,
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 20.0,
                    height: 20.0,
                },
                rotation_degrees: 0.0,
                corner_radius: 0.0,
                stroke_width: 0.0,
                shape_stroke_outset: 0.0,
                fill_rgba: [1.0; 4],
                stroke_rgba: [0.0; 4],
            },
        ]);
        assert_eq!(batch.rendered_node_ids, vec![1]);
        assert_eq!(batch.instance_floats.len(), GPU_INSTANCE_FLOATS);
        assert_eq!(batch.instance_floats[6], 10.0);
        assert_eq!(batch.instance_floats[7], 3.0);
    }

    #[test]
    fn aligned_full_ellipse_expands_the_shared_wgsl_quad() {
        let batch = build_gpu_instance_batch([GpuPrimitive {
            node_id: 7,
            kind: SceneNodeKind::Ellipse,
            bounds: Rect { x: 10.0, y: 20.0, width: 100.0, height: 50.0 },
            rotation_degrees: 0.0,
            corner_radius: 0.0,
            stroke_width: 8.0,
            shape_stroke_outset: 8.0,
            fill_rgba: [1.0, 0.0, 0.0, 1.0],
            stroke_rgba: [0.0, 0.0, 0.0, 1.0],
        }]);
        assert_eq!(batch.rendered_node_ids, vec![7]);
        assert_eq!(&batch.instance_floats[..4], &[2.0, 12.0, 116.0, 66.0]);
        assert_eq!(batch.instance_floats[7], 8.0);
    }

    #[test]
    fn aligned_rounded_rectangle_expands_bounds_and_corner_radius() {
        let batch = build_gpu_instance_batch([GpuPrimitive {
            node_id: 8,
            kind: SceneNodeKind::Rectangle,
            bounds: Rect { x: 10.0, y: 20.0, width: 100.0, height: 50.0 },
            rotation_degrees: 0.0,
            corner_radius: 12.0,
            stroke_width: 8.0,
            shape_stroke_outset: 8.0,
            fill_rgba: [1.0, 0.0, 0.0, 1.0],
            stroke_rgba: [0.0, 0.0, 0.0, 1.0],
        }]);
        assert_eq!(&batch.instance_floats[..4], &[2.0, 12.0, 116.0, 66.0]);
        assert_eq!(batch.instance_floats[6], 20.0);
        assert_eq!(batch.instance_floats[7], 8.0);
    }
}
