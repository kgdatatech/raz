import type { RoleId } from './roles'

export interface DispatchResult {
  role:       RoleId
  workflow:   string
  confidence: 'high' | 'medium' | 'low'
  reason:     string
}

interface Rule {
  patterns:   RegExp[]
  role:       RoleId
  workflow:   string
  confidence: 'high' | 'medium' | 'low'
  reason:     string
}

const RULES: Rule[] = [
  // ── Security ──────────────────────────────────────────────────────────────
  {
    patterns:   [/\b(security|secure|secured|vulnerable|vulnerability|vulnerabilities|xss|sql.?inject|csrf|exploit|pentest|hack|auth.?bypass|secret|secrets|leak|leaked|exposed?|exposure|CVE|owasp|posture|threat|breach|injection|credential|credentials|unauthorized|privilege|permission|attack)\b/i],
    role:       'RAZ-Sec', workflow: 'audit', confidence: 'high',
    reason:     'security keywords detected',
  },
  {
    patterns:   [/\b(audit|scan|review)\b/i, /\b(code|codebase|repo|project)\b/i],
    role:       'RAZ-Sec', workflow: 'audit', confidence: 'medium',
    reason:     'security audit of codebase',
  },

  // ── Testing ───────────────────────────────────────────────────────────────
  {
    patterns:   [/\b(test|spec|coverage|vitest|jest|assert|unit.?test|integration.?test|e2e)\b/i],
    role:       'RAZ-QA', workflow: 'test', confidence: 'high',
    reason:     'test keywords detected',
  },

  // ── Strategy / Planning ───────────────────────────────────────────────────
  {
    patterns:   [/\b(architect|plan|design|strateg|roadmap|how.?should|approach|think|consider|proposal|outline|breakdown)\b/i],
    role:       'RAZ-Ops', workflow: 'strategy', confidence: 'high',
    reason:     'strategic planning intent',
  },
  {
    patterns:   [/\b(audit|review|assess|analyz|evaluat|investigat|understand|survey|gap|gaps|missing|oversight|coverage|concern|attention|look.?at|check.?for|what.?need|anything.?wrong|anything.?broken|what.?issues)\b/i],
    role:       'RAZ-Ops', workflow: 'audit', confidence: 'medium',
    reason:     'audit / gap-finding intent',
  },

  // ── Data ──────────────────────────────────────────────────────────────────
  {
    patterns:   [/\b(database|schema|migration|query|SQL|ORM|model|seed|index|relation|table|column)\b/i],
    role:       'RAZ-Data', workflow: 'feature', confidence: 'high',
    reason:     'data layer keywords detected',
  },

  // ── Refactor ──────────────────────────────────────────────────────────────
  {
    patterns:   [/\b(refactor|clean.?up|reorganiz|restructur|rename|extract|simplif|dry|abstract)\b/i],
    role:       'RAZ-Dev', workflow: 'refactor', confidence: 'high',
    reason:     'refactor intent detected',
  },

  // ── Bug fix ───────────────────────────────────────────────────────────────
  {
    patterns:   [/\b(bug|fix|broken|crash|error|fail|issue|wrong|incorrect|not.?work|doesn.?t.?work|problem|defect|regression|exception|threw)\b/i],
    role:       'RAZ-Dev', workflow: 'fix', confidence: 'high',
    reason:     'bug fix keywords detected',
  },

  // ── Feature / Build ───────────────────────────────────────────────────────
  {
    patterns:   [/\b(build|implement|add|create|develop|write|make|ship|feature|new|extend|support|integrat|connect)\b/i],
    role:       'RAZ-Dev', workflow: 'feature', confidence: 'medium',
    reason:     'feature development intent',
  },
]

export function detectIntent(description: string): DispatchResult {
  const text = description.trim()

  for (const rule of RULES) {
    const allMatch = rule.patterns.every((p) => p.test(text))
    if (allMatch) {
      return { role: rule.role, workflow: rule.workflow, confidence: rule.confidence, reason: rule.reason }
    }
  }

  // Single-pattern pass (relaxed — first match wins)
  for (const rule of RULES) {
    if (rule.patterns[0].test(text)) {
      return { role: rule.role, workflow: rule.workflow, confidence: 'low', reason: `${rule.reason} (partial)` }
    }
  }

  // Default fallback
  return { role: 'RAZ-Dev', workflow: 'feature', confidence: 'low', reason: 'no clear signal detected' }
}
