import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { compressMessages } from '../agent-sdk'

function userMsg(toolResults: { id: string; content: string }[]): Anthropic.MessageParam {
  return {
    role: 'user',
    content: toolResults.map((r) => ({
      type:        'tool_result' as const,
      tool_use_id: r.id,
      content:     r.content,
    })),
  }
}

function assistantMsg(text: string): Anthropic.MessageParam {
  return { role: 'assistant', content: [{ type: 'text' as const, text }] }
}

function taskMsg(text: string): Anthropic.MessageParam {
  return { role: 'user', content: text }
}

describe('compressMessages()', () => {
  it('returns messages unchanged when below threshold', () => {
    const msgs: Anthropic.MessageParam[] = [
      taskMsg('Do X'),
      assistantMsg('I will do X'),
    ]
    const result = compressMessages(msgs, 6)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(msgs[0])
  })

  it('always preserves the first message (task)', () => {
    const task = taskMsg('The original task description')
    const msgs: Anthropic.MessageParam[] = [
      task,
      ...Array.from({ length: 16 }, (_, i) => i % 2 === 0
        ? userMsg([{ id: `tool-${i}`, content: 'x'.repeat(1000) }])
        : assistantMsg('y'.repeat(1000))
      ),
    ]
    const result = compressMessages(msgs, 6)
    expect(result[0]).toEqual(task)
  })

  it('preserves the last keepTurns*2 messages verbatim', () => {
    const msgs: Anthropic.MessageParam[] = [
      taskMsg('task'),
      ...Array.from({ length: 16 }, (_, i) => i % 2 === 0
        ? userMsg([{ id: `t${i}`, content: 'x'.repeat(1000) }])
        : assistantMsg('response')
      ),
    ]
    const result = compressMessages(msgs, 6)
    const expectedRecent = msgs.slice(-12) // keepTurns=6 → last 12 messages
    const actualRecent = result.slice(-12)
    expect(actualRecent).toEqual(expectedRecent)
  })

  it('truncates long tool results in old messages', () => {
    const longContent = 'A'.repeat(2000)
    const msgs: Anthropic.MessageParam[] = [
      taskMsg('task'),
      userMsg([{ id: 'old-tool', content: longContent }]),
      assistantMsg('ok'),
      // fill enough recent messages to push old ones past cutoff
      ...Array.from({ length: 14 }, (_, i) => i % 2 === 0
        ? userMsg([{ id: `new-${i}`, content: 'short' }])
        : assistantMsg('response')
      ),
    ]
    const result = compressMessages(msgs, 6)
    const oldUserMsg = result[1] as Anthropic.MessageParam
    const block = (oldUserMsg.content as Anthropic.ToolResultBlockParam[])[0]
    expect(typeof block.content).toBe('string')
    expect((block.content as string).length).toBeLessThan(longContent.length)
    expect(block.content as string).toContain('compressed')
  })

  it('does not truncate short tool results in old messages', () => {
    const shortContent = 'short result'
    const msgs: Anthropic.MessageParam[] = [
      taskMsg('task'),
      userMsg([{ id: 'old-tool', content: shortContent }]),
      assistantMsg('ok'),
      ...Array.from({ length: 14 }, (_, i) => i % 2 === 0
        ? userMsg([{ id: `new-${i}`, content: 'x' }])
        : assistantMsg('y')
      ),
    ]
    const result = compressMessages(msgs, 6)
    const oldUserMsg = result[1] as Anthropic.MessageParam
    const block = (oldUserMsg.content as Anthropic.ToolResultBlockParam[])[0]
    expect(block.content).toBe(shortContent)
  })

  it('truncates long assistant text in old messages', () => {
    const longText = 'B'.repeat(2000)
    const msgs: Anthropic.MessageParam[] = [
      taskMsg('task'),
      assistantMsg(longText),
      ...Array.from({ length: 14 }, (_, i) => i % 2 === 0
        ? userMsg([{ id: `t${i}`, content: 'x' }])
        : assistantMsg('short')
      ),
    ]
    const result = compressMessages(msgs, 6)
    const oldAssistant = result[1] as Anthropic.MessageParam
    const textBlock = (oldAssistant.content as Anthropic.TextBlock[])[0]
    expect(textBlock.text.length).toBeLessThan(longText.length)
    expect(textBlock.text).toContain('compressed')
  })
})
