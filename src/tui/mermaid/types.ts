export type MermaidDiagramKind =
  | "flowchart"
  | "state"
  | "class"
  | "er"
  | "sequence";

export type MermaidFlowDirection = "TD" | "TB" | "BT" | "LR" | "RL";
export type MermaidNodeShape = "rect" | "round" | "diamond";
export type MermaidEdgeStyle = "solid" | "dotted" | "thick";
export type MermaidEdgeArrow = "none" | "arrow" | "circle" | "cross";

export type MermaidFallbackReason =
  | "open_fence"
  | "blank_source"
  | "source_limit"
  | "unsupported_kind"
  | "unsupported_syntax"
  | "malformed_source"
  | "node_limit"
  | "edge_limit"
  | "member_limit"
  | "group_limit"
  | "depth_limit"
  | "sequence_limit"
  | "canvas_limit"
  | "width_limit";

export interface MermaidFenceSuccess {
  readonly ok: true;
  readonly language: "mermaid";
  readonly marker: "`" | "~";
  readonly markerLength: number;
  readonly source: string;
}

export type MermaidFenceResult = MermaidFenceSuccess | MermaidFenceFailure;

export interface MermaidFenceFailure {
  readonly ok: false;
  readonly reason: MermaidFallbackReason;
}

export interface MermaidFlowchartNode {
  readonly id: string;
  readonly label: string;
  readonly displayLines?: readonly string[];
  readonly shape: MermaidNodeShape;
  readonly order: number;
}

export interface MermaidFlowchartEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly style: MermaidEdgeStyle;
  readonly arrow: MermaidEdgeArrow;
  readonly startMarker?: string;
  readonly endMarker?: string;
  readonly startLabel?: string;
  readonly endLabel?: string;
  readonly order: number;
}

export interface MermaidFlowchartGroup {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly nodeIds: readonly string[];
  readonly order: number;
}

export interface MermaidFlowchartDiagram {
  readonly kind: "flowchart";
  readonly direction: MermaidFlowDirection;
  readonly nodes: readonly MermaidFlowchartNode[];
  readonly edges: readonly MermaidFlowchartEdge[];
  readonly groups: readonly MermaidFlowchartGroup[];
}

export type MermaidStateType = "normal" | "choice" | "start" | "end";

export interface MermaidStateNode {
  readonly id: string;
  readonly label: string;
  readonly stateType: MermaidStateType;
  readonly order: number;
}

export interface MermaidStateTransition {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly order: number;
}

export interface MermaidStateGroup {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly stateIds: readonly string[];
  readonly order: number;
}

export interface MermaidStateDiagram {
  readonly kind: "state";
  readonly direction: MermaidFlowDirection;
  readonly states: readonly MermaidStateNode[];
  readonly transitions: readonly MermaidStateTransition[];
  readonly groups: readonly MermaidStateGroup[];
}

export type MermaidClassMemberVisibility = "+" | "-" | "#" | "~";
export type MermaidClassMemberKind = "field" | "method";

export interface MermaidClassMember {
  readonly visibility: MermaidClassMemberVisibility;
  readonly kind: MermaidClassMemberKind;
  readonly name: string;
  readonly type?: string;
  readonly display: string;
  readonly order: number;
}

export interface MermaidClassNode {
  readonly id: string;
  readonly label: string;
  readonly generic?: string;
  readonly members: readonly MermaidClassMember[];
  readonly order: number;
}

export type MermaidClassRelationType =
  | "inheritance"
  | "composition"
  | "aggregation"
  | "dependency"
  | "association";

export interface MermaidClassRelation {
  readonly from: string;
  readonly to: string;
  readonly relation: MermaidClassRelationType;
  readonly operator: string;
  readonly label?: string;
  readonly leftCardinality?: string;
  readonly rightCardinality?: string;
  readonly order: number;
}

export interface MermaidClassDiagram {
  readonly kind: "class";
  readonly classes: readonly MermaidClassNode[];
  readonly relations: readonly MermaidClassRelation[];
}

export type MermaidErKey = "PK" | "FK" | "UK";

export interface MermaidErAttribute {
  readonly type: string;
  readonly name: string;
  readonly keys: readonly MermaidErKey[];
  readonly description?: string;
  readonly order: number;
}

export interface MermaidErEntity {
  readonly id: string;
  readonly label: string;
  readonly attributes: readonly MermaidErAttribute[];
  readonly order: number;
}

export interface MermaidErRelation {
  readonly from: string;
  readonly to: string;
  readonly leftCardinality: string;
  readonly rightCardinality: string;
  readonly identifying: boolean;
  readonly label?: string;
  readonly order: number;
}

export interface MermaidErDiagram {
  readonly kind: "er";
  readonly entities: readonly MermaidErEntity[];
  readonly relations: readonly MermaidErRelation[];
}

export type MermaidSequenceParticipantType = "participant" | "actor";

export interface MermaidSequenceParticipant {
  readonly id: string;
  readonly label: string;
  readonly participantType: MermaidSequenceParticipantType;
  readonly order: number;
}

export type MermaidSequenceMessageStyle = "solid" | "dotted";
export type MermaidSequenceMessageArrow = "arrow" | "cross";

export interface MermaidSequenceMessage {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly style: MermaidSequenceMessageStyle;
  readonly arrow: MermaidSequenceMessageArrow;
  readonly self: boolean;
  readonly lost: boolean;
  readonly activate?: "start" | "end";
  readonly number?: number;
  readonly order: number;
}

export type MermaidSequenceNotePosition = "over" | "left" | "right";

export interface MermaidSequenceNote {
  readonly position: MermaidSequenceNotePosition;
  readonly participantIds: readonly string[];
  readonly text: string;
  readonly order: number;
}

export type MermaidSequenceBlockKind = "loop" | "alt" | "opt" | "critical" | "box" | "rect";

export interface MermaidSequenceBlock {
  readonly kind: MermaidSequenceBlockKind;
  readonly label: string;
  readonly depth: number;
  readonly branches: readonly string[];
  readonly branchOrders: readonly number[];
  readonly order: number;
  readonly endOrder?: number;
}

export interface MermaidSequenceDiagram {
  readonly kind: "sequence";
  readonly autonumber: boolean;
  readonly autonumberStart: number;
  readonly autonumberIncrement: number;
  readonly participants: readonly MermaidSequenceParticipant[];
  readonly messages: readonly MermaidSequenceMessage[];
  readonly notes: readonly MermaidSequenceNote[];
  readonly blocks: readonly MermaidSequenceBlock[];
}

export type MermaidDiagram =
  | MermaidFlowchartDiagram
  | MermaidStateDiagram
  | MermaidClassDiagram
  | MermaidErDiagram
  | MermaidSequenceDiagram;

export type MermaidParseResult =
  | { readonly ok: true; readonly diagram: MermaidDiagram }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };

export type MermaidSemanticClass = "border" | "nodeText" | "edge" | "edgeLabel" | "title";

export interface MermaidStyledSpan {
  readonly start: number;
  readonly end: number;
  readonly className: MermaidSemanticClass;
}

export interface MermaidStyledLine {
  readonly text: string;
  readonly spans: readonly MermaidStyledSpan[];
}

export type MermaidProjectionResult =
  | {
      readonly ok: true;
      readonly width: number;
      readonly height: number;
      readonly lines: readonly MermaidStyledLine[];
      readonly estimatedBytes: number;
    }
  | { readonly ok: false; readonly reason: MermaidFallbackReason };
