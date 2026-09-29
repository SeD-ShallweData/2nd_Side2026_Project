import { describe, expect, it } from 'vitest';
import { ownedTurns, packMemory, scoreMemoryAnswer } from '../../scripts/memory-comparison-core';
import { HISTORY, FIXED_PROBES } from '../../scripts/memory-comparison-fixtures';
import type { StoredConversationDetail } from '../domain/conversation';

const count = async (text: string) => text.length;
describe('local memory comparison contract', () => {
  it('A selects only five complete turns while B retains older source facts', async () => {
    const a = await packMemory('A', HISTORY, [], count, 20000);
    const b = await packMemory('B', HISTORY, [], count, 20000);
    expect(a.selected_blocks).toEqual(['turn-22', 'turn-23', 'turn-24', 'turn-25']);
    expect(a.content).not.toContain('근로계약서 종이 원본');
    expect(b.content).toContain('근로계약서 종이 원본');
    expect(a.recent).toEqual(b.recent);
  });
  it('C uses only completed checkpoints before the common last turn', async () => {
    const summaries = [10, 20, 30, 40, 50].map(through => ({ through, content: `summary ${through}` }));
    for (const [turns, checkpoint] of [[5, 0], [6, 10], [20, 30], [26, 50]]) {
      const c = await packMemory('C', HISTORY.slice(0, turns), summaries, count, 20000);
      expect(c.summary_through).toBe(checkpoint);
      if (checkpoint) expect(c.content).toContain(`summary ${checkpoint}`);
      expect(c.content).not.toContain(`summary ${checkpoint + 10}`);
    }
  });
  it('trims whole old blocks, records truncation, and blocks an oversized newest turn', async () => {
    const result = await packMemory('B', HISTORY, [], count, 1500);
    expect(result.tokens).toBeLessThanOrEqual(1500);
    expect(result.removed_blocks[0]).toBe('turn-1');
    expect(result.recent[0].content).toContain(HISTORY.at(-1)!.user);
    const c = await packMemory('C', HISTORY, [{ through: 50, content: 'x'.repeat(5000) }], count, 1000);
    expect(c.summary_retained).toBe(false);
    expect(c.removed_blocks).toEqual(['summary-through-50']);
    await expect(packMemory('A', HISTORY, [], count, 1)).rejects.toThrow('LATEST_TURN_EXCEEDS_MEMORY_BUDGET');
  });
  it('rejects a different owner, room, and incomplete turn before exposing content', () => {
    const detail = { conversation_id: 'room', owner_user_id: 'owner', turns: [] } as unknown as StoredConversationDetail;
    expect(() => ownedTurns(detail, 'room', 'other')).toThrow('OWNER_SCOPE_REJECTED');
    expect(() => ownedTurns(detail, 'other-room', 'owner')).toThrow('OWNER_SCOPE_REJECTED');
    expect(ownedTurns(detail, 'room', 'owner')).toEqual([]);
    expect(() => ownedTurns({ ...detail, turns: [{ messages: [] }] } as unknown as StoredConversationDetail, 'room', 'owner')).toThrow('INCOMPLETE_TURN');
  });
  it('keeps expected answers output-only and does not call lexical PASS truth validation', async () => {
    const packed = await packMemory('A', HISTORY, [], count, 20000);
    expect(JSON.stringify(packed)).not.toContain('expected');
    const score = scoreMemoryAnswer('한빛테크 18일', [{ fact: 'correction', pattern: '18일' }]);
    expect(score.automated_status).toBe('PASS');
    expect(score.attribution_and_fabrication_review).toBe('REQUIRES_SOURCE_REVIEW');
    expect(scoreMemoryAnswer('급여일 15일, 회사는 다음 주에 지급하겠다고 했습니다.', FIXED_PROBES[0].expected).automated_status).toBe('PASS');
  });
});
