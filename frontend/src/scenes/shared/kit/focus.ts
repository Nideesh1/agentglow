/**
 * Click-to-focus, shared by every theme: a single click on a node (agent, service, MCP server, backend satellite,
 * service link, grouped cluster) selects it (details panel as before) and flies the camera to it (fit.ts flyTo);
 * a click on empty space or Esc unselects and eases back to the normal auto-fit (flyHome).
 */
import * as THREE from "three";
import type { ResSel } from "../resinfo";
import { selectInstance, selectResource } from "../world";
import { flyHome, flyTo } from "./fit";
import { agentLive, backendPos, kit, serverPos } from "./state";

const _p = new THREE.Vector3();

/** fly to an agent (followed while it moves) */
export function focusAgent(id: string) {
  flyTo(() => kit.agents.get(id)?.live, () => (kit.agents.get(id)?.scale ?? 1) * 1.1);
}

/** fly to a selected resource: server, backend satellite, or a link (its caller end) */
export function focusResource(sel: ResSel) {
  if (sel.type === "server") flyTo(() => serverPos(sel.server), () => 1.6);
  else if (sel.type === "backend") flyTo(() => backendPos(sel.server, sel.resource) ?? serverPos(sel.server), () => 1.2);
  else flyTo(() => agentLive(sel.id) ?? serverPos(sel.server), () => 1.6);
}

/** fly to a grouped cluster (it expands into its members on the same click) */
export function focusCluster(lane: number) {
  flyTo(() => (kit.clusterPos[lane] ? _p.copy(kit.clusterPos[lane]) : undefined), () => 2.4);
}

/** unselect everything and ease the camera back to the auto-fit */
export function unfocus() {
  selectInstance(null);
  selectResource(null);
  flyHome();
}
