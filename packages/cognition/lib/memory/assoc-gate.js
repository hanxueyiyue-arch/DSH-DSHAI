/**
 * 关联证据资格闸（T1f，安全修复）。
 *
 * 要修的问题：T1e 实测发现，一条 25 天前写下的 co-cite 边（w=0.30）在目标记忆
 * `S=0、sim=0`（等于"完全没有线索、也几乎不留痕迹"）时仍能把 `W` 推到 0.302，
 * 越过 `θ_wake=0.30`——单条关联证据无条件唤醒了本不该被想起的东西。
 *
 * 修法：**不动 T1a 的通用公式**，只在"这条候选是靠关联才进来的"这一步加资格判断。
 * 关联证据可以排序、可以加强已有线索，但不能单独把一条极弱的记忆拽进结果。
 *
 * 三条放行理由，按顺序判断：
 *   1. 有字面线索（sim ≥ 0.05）——关联只负责加分，不负责唤醒；
 *   2. 记忆本身够强（S ≥ 0.48）——它自己就接近能被想起来，关联只是补最后一脚；
 *   3. 至少两段独立经历为这条边作证（evidence ≥ 2）——一次是巧合，两次才是模式。
 *
 * 这三个数都不是新拍脑袋的数：0.05 与 0.48 就是设计里第二跳条款的既有取值
 * （`secondHopMinSim` / `secondHopMinStrength`），2 是"独立证据"的计数而不是分数。
 * 阈值本身也可由调用方覆盖，但**不得为了过闸把 θ 或 η 调成特定数值**（D-023）。
 */

import { WAKE_PARAMS } from './wakeability.js';

export const ASSOC_GATE = Object.freeze({
  minSim: WAKE_PARAMS.secondHopMinSim,
  minStrength: WAKE_PARAMS.secondHopMinStrength,
  minEvidence: 2,
  status: 'candidate',
});

/**
 * @param {{sim?: number, assoc?: number, strength?: number, evidence?: number}} evidence
 * @param {{minSim?: number, minStrength?: number, minEvidence?: number}} params
 * @returns {{allowed: boolean, reason: string}}
 */
export function associationGate({ sim = 0, assoc = 0, strength = 0, evidence = 1 } = {}, params = {}) {
  const minSim = Number(params.minSim ?? ASSOC_GATE.minSim);
  const minStrength = Number(params.minStrength ?? ASSOC_GATE.minStrength);
  const minEvidence = Number(params.minEvidence ?? ASSOC_GATE.minEvidence);

  if (!(Number(assoc) > 0)) return { allowed: false, reason: 'no-association' };
  if (Number(sim) >= minSim) return { allowed: true, reason: 'literal-cue' };
  if (Number(strength) >= minStrength) return { allowed: true, reason: 'strong-memory' };
  if (Number(evidence) >= minEvidence) return { allowed: true, reason: 'independent-evidence' };
  return { allowed: false, reason: 'weak-memory-single-evidence' };
}

/** 只回答"能不能靠这条路进来"，用于诊断输出。 */
export function gateReason(input, params) {
  return associationGate(input, params).reason;
}
