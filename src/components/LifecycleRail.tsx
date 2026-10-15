// duidelik — lifecycle rail (§6.4) + compact pipeline (§6.5)
//
// Pure presentational: derive each node's state from the product stage × each doc's
// status. The FSD node renders LOCKED (🔒) until the BRD is SIGNED (hard gate, §6.4).
// Ported from app/ui/rail.js (hyperscript → JSX); Shoprite classes unchanged.

import { Fragment } from "react";
import { LifecycleStage, DocStatus, DocType, stageIndex } from "../core/enums";
import type { DocTypeValue } from "../core/enums";
import type { DataProduct, DuidelikDocument } from "../types";

type DocFor = (type: DocTypeValue) => DuidelikDocument | null;

interface RailNodeDef {
  stage: string;
  n: string;
  label: string;
  doc: DocTypeValue | null;
}

const NODES: RailNodeDef[] = [
  { stage: LifecycleStage.BRD, n: "①", label: "BRD", doc: DocType.BRD },
  { stage: LifecycleStage.FSD, n: "②", label: "FSD", doc: DocType.FSD },
  { stage: LifecycleStage.QRG, n: "③", label: "QRG", doc: DocType.QRG },
  { stage: LifecycleStage.QRG, n: "④", label: "Glossary", doc: null },
  { stage: LifecycleStage.LIVE, n: "⑤", label: "Live", doc: null },
];

function fsdSigned(docFor: DocFor): boolean {
  const f = docFor(DocType.FSD);
  return !!f && f.status === DocStatus.SIGNED;
}

type NodeState = "done" | "active" | "locked" | "future";

function nodeState(node: RailNodeDef, product: DataProduct, docFor: DocFor, prevSigned: boolean): NodeState {
  const curIdx = stageIndex(product.stage);
  const nodeIdx = stageIndex(node.stage as any);
  const doc = node.doc ? docFor(node.doc) : null;

  if (node.label === "Live") return product.stage === LifecycleStage.LIVE ? "done" : "future";
  if (node.label === "Glossary") return "future"; // always-available side tab, shown muted on the rail

  if (doc && (doc.status === DocStatus.SIGNED || doc.status === DocStatus.PUBLISHED)) return "done";
  if (nodeIdx === curIdx) return "active";
  // FSD before BRD signed → locked (the hard gate)
  if (node.doc === DocType.FSD && !prevSigned) return "locked";
  if (node.doc === DocType.QRG && !fsdSigned(docFor)) return nodeIdx > curIdx ? "future" : "active";
  return nodeIdx > curIdx ? "future" : "active";
}

export function LifecycleRail({
  product,
  docFor,
  invalidatedBanner,
}: {
  product: DataProduct;
  docFor: DocFor;
  invalidatedBanner?: string | null;
}) {
  const brd = docFor(DocType.BRD);
  const brdSigned = !!brd && brd.status === DocStatus.SIGNED;

  return (
    <div>
      {invalidatedBanner ? <div className="invalidation-banner">{"⟲ " + invalidatedBanner}</div> : null}
      <ol
        className="lifecycle-rail"
        aria-label="lifecycle"
        style={{ listStyle: "none", padding: 0, margin: invalidatedBanner ? "10px 0 0" : 0 }}
      >
        {NODES.map((node, i) => {
          const st = nodeState(node, product, docFor, brdSigned);
          const cls = "rail-node rail-node--" + st;
          const glyph = st === "done" ? " ✓" : st === "locked" ? " 🔒" : "";
          return (
            <Fragment key={node.label}>
              <li className={cls} aria-current={st === "active" ? "step" : undefined}>
                {`${node.n} ${node.label}${glyph}`}
                {st === "active" ? <span className="sub"> · active</span> : null}
              </li>
              {i < NODES.length - 1 ? (
                <li
                  className={"rail-conn " + (st === "done" ? "rail-conn--done" : "rail-conn--near")}
                  aria-hidden="true"
                />
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

function brdLabel(brd: DuidelikDocument | null): string {
  if (!brd) return "BRD";
  if (brd.status === DocStatus.SIGNED) return "BRD ✓ signed";
  if (brd.status === DocStatus.IN_RIGOUR) return "BRD ⚑ rigour gate";
  return "BRD ● drafting";
}
function fsdLabel(fsd: DuidelikDocument | null, brdSigned: boolean): string {
  if (!brdSigned) return "FSD 🔒 locked";
  if (!fsd) return "FSD";
  if (fsd.status === DocStatus.SIGNED) return "FSD ✓ signed";
  return "FSD ● drafting";
}

export function Pipeline({ product, docFor }: { product: DataProduct; docFor: DocFor }) {
  const brd = docFor(DocType.BRD);
  const fsd = docFor(DocType.FSD);
  const qrg = docFor(DocType.QRG);
  const brdSigned = !!brd && brd.status === DocStatus.SIGNED;

  const brdState = !brd
    ? "future"
    : brd.status === DocStatus.SIGNED
      ? "done"
      : brd.status === DocStatus.IN_RIGOUR
        ? "blocked"
        : "active";
  const fsdState = !brdSigned ? "locked" : !fsd ? "future" : fsd.status === DocStatus.SIGNED ? "done" : "active";
  const qrgState = product.stage === LifecycleStage.LIVE ? "done" : qrg ? "active" : "future";
  const liveState = product.stage === LifecycleStage.LIVE ? "done" : "future";

  const node = (label: string, state: string, key: string) => (
    <span className={"pipeline__node pipeline__node--" + state} key={key}>
      {label}
    </span>
  );
  const conn = (k: string) => (
    <span className="pipeline__conn" key={k} aria-hidden="true">
      ──
    </span>
  );

  return (
    <div className="pipeline">
      {node(brdLabel(brd), brdState, "brd")}
      {conn("a")}
      {node(fsdLabel(fsd, brdSigned), fsdState, "fsd")}
      {conn("b")}
      {node("QRG", qrgState, "qrg")}
      {conn("c")}
      {node("Live", liveState, "live")}
    </div>
  );
}
