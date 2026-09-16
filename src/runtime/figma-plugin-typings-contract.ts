import type {} from "@figma/plugin-typings";
import { FIGMA_PLUGIN_TYPINGS_VERSION } from "./runtime-capabilities";

/**
 * Compile-only probes for the exact Plugin API surface M0 uses as its external
 * contract. This function is intentionally never invoked by the application.
 */
export function assertFigmaPluginTypingsContract(
  node: SceneNode,
  rectangle: RectangleNode,
  component: ComponentNode,
  instance: InstanceNode,
  componentSet: ComponentSetNode,
  text: TextNode,
): {
  version: typeof FIGMA_PLUGIN_TYPINGS_VERSION;
  allPages: Promise<void>;
  nodeLookup: Promise<BaseNode | null>;
  svg: Promise<string>;
  reactions: readonly Reaction[];
} {
  void figma.variables.getLocalVariablesAsync();
  void figma.variables.getLocalVariableCollectionsAsync();
  void figma.variables.getVariableByIdAsync("V:spacing");
  const createdComponent: ComponentNode = figma.createComponent();
  const convertedComponent: ComponentNode = figma.createComponentFromNode(figma.createFrame());
  const createdSlice: SliceNode = figma.createSlice();
  createdComponent.appendChild(figma.createRectangle());
  const createdInstance: InstanceNode = createdComponent.createInstance();
  void createdInstance.mainComponent;
  void convertedComponent.children;
  createdSlice.resize(320, 180);
  node.x = node.x;
  node.y = node.y;
  node.name = node.name;
  rectangle.opacity = rectangle.opacity;
  const floatVariable = figma.variables.getLocalVariables("FLOAT")[0];
  if (floatVariable) {
    floatVariable.setVariableCodeSyntax("WEB", "--spacing");
    floatVariable.removeVariableCodeSyntax("WEB");
    void floatVariable.codeSyntax.WEB;
    rectangle.setBoundVariable("opacity", floatVariable);
    rectangle.setBoundVariable("width", floatVariable);
    rectangle.setBoundVariable("cornerRadius", floatVariable);
  }
  void rectangle.cornerRadius;
  rectangle.topLeftRadius = rectangle.topLeftRadius;
  const stringVariable = figma.variables.getLocalVariables("STRING")[0];
  if (stringVariable) text.setBoundVariable("characters", stringVariable);
  const colorVariable = figma.variables.getLocalVariables("COLOR")[0];
  if (colorVariable) rectangle.fills = [figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 1, g: 0, b: 0 } }, "color", colorVariable)];
  if (colorVariable) rectangle.strokes = [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 }, boundVariables: { color: figma.variables.createVariableAlias(colorVariable) } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }];
  if (floatVariable) rectangle.effects = [figma.variables.setBoundVariableForEffect({ type: "LAYER_BLUR", radius: 4, visible: true, blurType: "NORMAL" }, "radius", floatVariable)];
  void rectangle.boundVariables;
  const variableCollection = figma.variables.getLocalVariableCollections()[0];
  if (variableCollection) rectangle.setExplicitVariableModeForCollection(variableCollection, variableCollection.defaultModeId);
  void rectangle.explicitVariableModes;
  void rectangle.resolvedVariableModes;
  rectangle.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5, blendMode: "MULTIPLY" }];
  rectangle.strokes = [{
    type: "GRADIENT_LINEAR",
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }],
  }];
  rectangle.fills = [{
    type: "IMAGE",
    imageHash: null,
    scaleMode: "FILL",
    filters: { exposure: .25, contrast: -.1, saturation: .2, temperature: -.3, tint: .4, highlights: -.5, shadows: .6 },
  }];
  const paints: readonly Paint[] = rectangle.fills;
  void paints;
  rectangle.fillStyleId = "S:brand-fill";
  rectangle.strokeStyleId = "S:brand-stroke";
  if (false) void rectangle.setFillStyleIdAsync("S:brand-fill");
  if (false) void rectangle.setStrokeStyleIdAsync("S:brand-stroke");
  component.backgroundStyleId = "S:brand-fill";
  text.textAutoResize = "HEIGHT";
  text.textTruncation = "ENDING";
  text.maxLines = 2;
  text.insertCharacters(0, "A", "AFTER");
  text.setRangeFontSize(0, 1, 16);
  text.letterSpacing = { value: 1, unit: "PIXELS" };
  void text.getRangeLetterSpacing(0, 1);
  text.setRangeLetterSpacing(0, 1, { value: -0.25, unit: "PIXELS" });
  void text.hasMissingFont;
  text.fontSize = 16;
  void text.fontSize;
  void text.fontWeight;
  void text.getRangeFontSize(0, 1);
  void text.getRangeFontWeight(0, 1);
  void text.openTypeFeatures;
  void text.getRangeOpenTypeFeatures(0, 1);
  void text.textStyleId;
  void text.getRangeTextStyleId(0, 1);
  text.textStyleId = "S:body";
  if (false) void text.setTextStyleIdAsync("S:body");
  text.setRangeTextStyleId(0, 1, "S:body");
  if (false) void text.setRangeTextStyleIdAsync(0, 1, "S:body");
  void text.fillStyleId;
  void text.getRangeFillStyleId(0, 1);
  text.fillStyleId = "S:brand-fill";
  if (false) void text.setFillStyleIdAsync("S:brand-fill");
  text.setRangeFillStyleId(0, 1, "S:brand-fill");
  if (false) void text.setRangeFillStyleIdAsync(0, 1, "S:brand-fill");
  void text.fontName;
  void text.getRangeFontName(0, 1);
  void text.getRangeAllFontNames(0, 1);
  text.setRangeFontName(0, 1, { family: "Inter", style: "Regular" });
  text.textCase = "UPPER";
  void text.getRangeTextCase(0, 1);
  text.setRangeTextCase(0, 1, "TITLE");
  text.textDecoration = "UNDERLINE";
  void text.getRangeTextDecoration(0, 1);
  text.setRangeTextDecoration(0, 1, "STRIKETHROUGH");
  text.textDecorationStyle = "WAVY";
  void text.getRangeTextDecorationStyle(0, 1);
  text.setRangeTextDecorationStyle(0, 1, "DOTTED");
  void text.textDecorationOffset;
  text.textDecorationOffset = { unit: "AUTO" };
  void text.getRangeTextDecorationOffset(0, 1);
  text.setRangeTextDecorationOffset(0, 1, { value: 10, unit: "PERCENT" });
  void text.textDecorationThickness;
  text.textDecorationThickness = { unit: "AUTO" };
  void text.getRangeTextDecorationThickness(0, 1);
  text.setRangeTextDecorationThickness(0, 1, { value: 2, unit: "PIXELS" });
  void text.textDecorationColor;
  text.textDecorationColor = { value: "AUTO" };
  void text.getRangeTextDecorationColor(0, 1);
  text.setRangeTextDecorationColor(0, 1, { value: { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 } });
  text.textWrapStyle = "BALANCE";
  void text.textWrapStyle;
  void text.getRangeTextWrapStyle(0, 1);
  text.setRangeTextWrapStyle(0, 1, "PRETTY");
  void text.textDecorationSkipInk;
  text.textDecorationSkipInk = true;
  void text.leadingTrim;
  text.leadingTrim = "CAP_HEIGHT";
  void text.getRangeListOptions(0, text.characters.length);
  text.setRangeListOptions(0, text.characters.length, { type: "UNORDERED" });
  text.listSpacing = 6;
  void text.listSpacing;
  text.hangingList = true;
  void text.hangingList;
  text.hangingPunctuation = true;
  void text.hangingPunctuation;
  void text.getRangeListSpacing(0, text.characters.length);
  text.setRangeListSpacing(0, text.characters.length, 8);
  void text.getRangeIndentation(0, text.characters.length);
  text.setRangeIndentation(0, text.characters.length, 2);
  void text.getRangeTextDecorationSkipInk(0, 1);
  text.setRangeTextDecorationSkipInk(0, 1, false);
  text.hyperlink = { type: "URL", value: "https://example.com" };
  void text.getRangeHyperlink(0, 1);
  text.setRangeHyperlink(0, 1, { type: "NODE", value: "1:2" });
  text.setRangeFills(0, 1, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 }]);
  void text.getRangeFills(0, 1);
  void text.getStyledTextSegments(["fontName", "fontSize", "fontWeight", "fontStyle", "textCase", "lineHeight", "fills", "listOptions", "listSpacing", "indentation", "paragraphIndent", "paragraphSpacing", "textWrapStyle", "hyperlink"]);
  text.deleteCharacters(0, 1);

  const action: Action = { type: "URL", url: "https://example.com", openInNewTab: true };
  const reactions: readonly Reaction[] = [{ trigger: { type: "ON_CLICK" }, actions: [action] }];
  const allPages: Promise<void> = figma.loadAllPagesAsync();
  const nodeLookup: Promise<BaseNode | null> = figma.getNodeByIdAsync("0:0");
  const svg: Promise<string> = node.exportAsync({ format: "SVG_STRING" });
  void component.key;
  void component.remote;
  void component.description;
  void component.descriptionMarkdown;
  void component.documentationLinks;
  void component.componentPropertyDefinitions;
  void component.getInstancesAsync();
  void instance.componentProperties;
  void instance.overrides;
  void instance.scaleFactor;
  void instance.isExposedInstance;
  void instance.getMainComponentAsync();
  instance.removeOverrides();
  void componentSet.variantGroupProperties;
  const polygon: PolygonNode = figma.createPolygon();
  polygon.pointCount = polygon.pointCount;
  const star: StarNode = figma.createStar();
  star.pointCount = star.pointCount;
  star.innerRadius = star.innerRadius;
  const vector: VectorNode = figma.createVector();
  vector.vectorPaths = [{ windingRule: "NONE", data: "M 0 0 L 120 80" }];
  const vectorNetwork: VectorNetwork = vector.vectorNetwork;
  void vectorNetwork.vertices;
  void vectorNetwork.segments;
  if (false) void vector.setVectorNetworkAsync({
    vertices: [{ x: 0, y: 0, strokeCap: "ROUND" }, { x: 120, y: 80, strokeCap: "ARROW_LINES" }],
    segments: [{ start: 0, end: 1 }],
  });
  vector.strokeWeight = 3;
  const strokeCap = vector.strokeCap;
  if (strokeCap !== figma.mixed) vector.strokeCap = strokeCap;
  vector.strokeCap = "ROUND";
  vector.strokeJoin = "BEVEL";
  vector.strokeMiterLimit = 4;
  vector.dashPattern = [8, 4];
  const boolean: BooleanOperationNode = figma.union([vector, figma.createVector()], figma.currentPage);
  boolean.booleanOperation = "EXCLUDE";
  const flattened: VectorNode = figma.flatten([boolean]);
  void flattened;
  const frame: FrameNode = figma.createFrame();
  frame.layoutMode = "HORIZONTAL";
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  frame.primaryAxisAlignItems = "SPACE_BETWEEN";
  frame.counterAxisAlignItems = "BASELINE";
  frame.minWidth = 120;
  frame.maxWidth = 640;
  frame.strokeTopWeight = 1;
  frame.strokeRightWeight = 2;
  frame.strokeBottomWeight = 3;
  frame.strokeLeftWeight = 4;
  frame.appendChild(rectangle);
  if (floatVariable) {
    frame.setBoundVariable("itemSpacing", floatVariable);
    frame.setBoundVariable("paddingLeft", floatVariable);
    frame.setBoundVariable("strokeTopWeight", floatVariable);
    rectangle.setBoundVariable("minWidth", floatVariable);
  }
  if (false) void figma.flatten([boolean], frame, 0);
  rectangle.layoutSizingHorizontal = "FILL";
  rectangle.layoutSizingVertical = "FIXED";
  rectangle.layoutPositioning = "AUTO";
  rectangle.layoutAlign = "CENTER";
  rectangle.constraints = { horizontal: "STRETCH", vertical: "CENTER" };
  const wrapFrame: FrameNode = figma.createFrame();
  wrapFrame.layoutMode = "HORIZONTAL";
  wrapFrame.layoutWrap = "WRAP";
  wrapFrame.counterAxisSpacing = 12;
  if (floatVariable) wrapFrame.setBoundVariable("counterAxisSpacing", floatVariable);
  wrapFrame.counterAxisAlignContent = "SPACE_BETWEEN";
  const connector: ConnectorNode = figma.createConnector();
  connector.connectorLineType = "ELBOWED";
  connector.connectorStart = { position: { x: 0, y: 0 } };
  connector.connectorEnd = { endpointNodeId: rectangle.id, magnet: "RIGHT" };
  connector.connectorStartStrokeCap = "ARROW_LINES";
  connector.connectorEndStrokeCap = "ERD_ONE_OR_MORE";
  const shapeWithText: ShapeWithTextNode = figma.createShapeWithText();
  shapeWithText.shapeType = "DIAMOND";
  shapeWithText.text.characters = "Approve";
  shapeWithText.text.fontSize = 18;
  void shapeWithText.text.hasMissingFont;
  void shapeWithText.text.fontWeight;
  void shapeWithText.text.getRangeFontSize(0, 7);
  void shapeWithText.text.getRangeFontWeight(0, 7);
  void shapeWithText.text.openTypeFeatures;
  void shapeWithText.text.getRangeOpenTypeFeatures(0, 7);
  void shapeWithText.text.fontName;
  void shapeWithText.text.getRangeFontName(0, 7);
  void shapeWithText.text.getRangeAllFontNames(0, 7);
  shapeWithText.text.setRangeFontName(0, 7, { family: "Inter", style: "Regular" });
  shapeWithText.text.textCase = "SMALL_CAPS";
  void shapeWithText.text.getRangeTextCase(0, 7);
  shapeWithText.text.setRangeTextCase(0, 7, "SMALL_CAPS_FORCED");
  shapeWithText.text.textDecoration = "UNDERLINE";
  void shapeWithText.text.getRangeTextDecoration(0, 7);
  shapeWithText.text.setRangeTextDecoration(0, 7, "NONE");
  shapeWithText.text.textDecorationStyle = "SOLID";
  void shapeWithText.text.getRangeTextDecorationStyle(0, 7);
  shapeWithText.text.setRangeTextDecorationStyle(0, 7, "WAVY");
  void shapeWithText.text.textDecorationOffset;
  shapeWithText.text.textDecorationOffset = { value: 2, unit: "PIXELS" };
  void shapeWithText.text.getRangeTextDecorationOffset(0, 7);
  shapeWithText.text.setRangeTextDecorationOffset(0, 7, { unit: "AUTO" });
  void shapeWithText.text.textDecorationThickness;
  shapeWithText.text.textDecorationThickness = { value: 8, unit: "PERCENT" };
  void shapeWithText.text.getRangeTextDecorationThickness(0, 7);
  shapeWithText.text.setRangeTextDecorationThickness(0, 7, { unit: "AUTO" });
  void shapeWithText.text.textDecorationColor;
  shapeWithText.text.textDecorationColor = { value: "AUTO" };
  void shapeWithText.text.getRangeTextDecorationColor(0, 7);
  shapeWithText.text.setRangeTextDecorationColor(0, 7, { value: { type: "SOLID", color: { r: 0, g: .5, b: 1 }, opacity: .75 } });
  void shapeWithText.text.textDecorationSkipInk;
  shapeWithText.text.textDecorationSkipInk = true;
  void shapeWithText.text.leadingTrim;
  shapeWithText.text.leadingTrim = "CAP_HEIGHT";
  void shapeWithText.text.getRangeListOptions(0, shapeWithText.text.characters.length);
  shapeWithText.text.setRangeListOptions(0, shapeWithText.text.characters.length, { type: "UNORDERED" });
  shapeWithText.text.listSpacing = 6;
  void shapeWithText.text.listSpacing;
  shapeWithText.text.hangingList = true;
  void shapeWithText.text.hangingList;
  shapeWithText.text.hangingPunctuation = true;
  void shapeWithText.text.hangingPunctuation;
  void shapeWithText.text.getRangeListSpacing(0, shapeWithText.text.characters.length);
  shapeWithText.text.setRangeListSpacing(0, shapeWithText.text.characters.length, 8);
  void shapeWithText.text.getRangeIndentation(0, shapeWithText.text.characters.length);
  shapeWithText.text.setRangeIndentation(0, shapeWithText.text.characters.length, 2);
  void shapeWithText.text.getRangeTextDecorationSkipInk(0, 7);
  shapeWithText.text.setRangeTextDecorationSkipInk(0, 7, false);
  shapeWithText.text.hyperlink = { type: "URL", value: "https://example.com" };
  void shapeWithText.text.getRangeHyperlink(0, 7);
  shapeWithText.text.setRangeHyperlink(0, 7, null);
  shapeWithText.text.setRangeFontSize(0, 7, 20);
  shapeWithText.text.setRangeLetterSpacing(0, 7, { value: 1, unit: "PIXELS" });
  shapeWithText.text.lineHeight = { value: 24, unit: "PIXELS" };
  shapeWithText.text.lineHeight = { value: 125, unit: "PERCENT" };
  shapeWithText.text.lineHeight = { unit: "AUTO" };
  void shapeWithText.text.lineHeight;
  shapeWithText.text.paragraphSpacing = 8;
  void shapeWithText.text.paragraphSpacing;
  shapeWithText.text.paragraphIndent = 12;
  void shapeWithText.text.paragraphIndent;
  shapeWithText.text.textWrapStyle = "BALANCE";
  void shapeWithText.text.textWrapStyle;
  void shapeWithText.text.getRangeLineHeight(0, 7);
  shapeWithText.text.setRangeLineHeight(0, 7, { value: 26, unit: "PIXELS" });
  void shapeWithText.text.getRangeParagraphSpacing(0, 7);
  shapeWithText.text.setRangeParagraphSpacing(0, 7, 10);
  void shapeWithText.text.getRangeParagraphIndent(0, 7);
  shapeWithText.text.setRangeParagraphIndent(0, 7, 14);
  void shapeWithText.text.getRangeTextWrapStyle(0, 7);
  shapeWithText.text.setRangeTextWrapStyle(0, 7, "PRETTY");
  shapeWithText.text.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 1 } }];
  shapeWithText.text.fillStyleId = "S:brand-fill";
  if (false) void shapeWithText.text.setFillStyleIdAsync("S:brand-fill");
  void shapeWithText.text.getRangeFillStyleId(0, 7);
  shapeWithText.text.setRangeFillStyleId(0, 7, "S:brand-fill");
  if (false) void shapeWithText.text.setRangeFillStyleIdAsync(0, 7, "S:brand-fill");
  shapeWithText.text.setRangeFills(0, 7, [{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: .5 }]);
  void shapeWithText.text.getRangeFills(0, 7);
  void shapeWithText.text.getStyledTextSegments(["fontSize", "fontStyle", "paragraphSpacing", "textWrapStyle"], 0, 7);
  shapeWithText.text.insertCharacters(7, "d", "AFTER");
  const textPath: TextPathNode = figma.createTextPath(vector, 0, .25);
  textPath.textAlignHorizontal = "CENTER";
  textPath.textAlignVertical = "TOP";
  textPath.autoRename = false;
  const transformGroup: TransformGroupNode = figma.transformGroup(
    [figma.createRectangle(), figma.createEllipse()],
    figma.currentPage,
    0,
    [{ type: "REPEAT", repeatType: "LINEAR", count: 2, unitType: "PIXELS", offset: 120, axis: "HORIZONTAL" }],
  );
  transformGroup.transformModifiers = transformGroup.transformModifiers;
  transformGroup.transformModifiers = [{ type: "REPEAT", repeatType: "RADIAL", count: 5, unitType: "PIXELS", offset: 64 }];
  transformGroup.transformModifiers = [
    { type: "REPEAT", repeatType: "LINEAR", count: 1, unitType: "PIXELS", offset: 120, axis: "HORIZONTAL" },
    { type: "REPEAT", repeatType: "RADIAL", count: 3, unitType: "PIXELS", offset: 64 },
  ];

  return { version: FIGMA_PLUGIN_TYPINGS_VERSION, allPages, nodeLookup, svg, reactions };
}
