import { desc, eq, like, or } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { memoryFacts } from '../../db/schema.js';

export interface RecordFactInput {
  subject: string; // e.g. a Jira key, "pr:org/repo#12", "slack:C1:169..."
  content: Record<string, unknown>;
  sourceSystem: 'jira' | 'github' | 'slack';
  sourceRef?: string;
  observedAt?: Date;
}

export interface RecordConclusionInput {
  subject: string;
  content: Record<string, unknown>;
  sourceRef?: string;
  observedAt?: Date;
}

/** Structured memory distinguishing what was actually observed from a
 * connected system (kind: "fact") from what the AI concluded about it
 * (kind: "conclusion") — so a later reader (human or agent) can tell which
 * is which, per the spec's requirement not to blur the two. */
export class WorkMemoryStore {
  constructor(private db: AnyDb) {}

  async recordFact(input: RecordFactInput): Promise<void> {
    await this.db.insert(memoryFacts).values({
      kind: 'fact',
      subject: input.subject,
      content: input.content,
      sourceSystem: input.sourceSystem,
      sourceRef: input.sourceRef ?? null,
      observedAt: input.observedAt ?? new Date(),
    });
  }

  async recordConclusion(input: RecordConclusionInput): Promise<void> {
    await this.db.insert(memoryFacts).values({
      kind: 'conclusion',
      subject: input.subject,
      content: input.content,
      sourceSystem: 'ai',
      sourceRef: input.sourceRef ?? null,
      observedAt: input.observedAt ?? new Date(),
    });
  }

  async forSubject(subject: string) {
    return this.db.select().from(memoryFacts).where(eq(memoryFacts.subject, subject)).orderBy(desc(memoryFacts.id));
  }

  /** Simple substring search over subject and source_ref — enough to answer
   * "what do we know about X" without pulling in a search engine for what's
   * currently a modest table. */
  async search(query: string, limit = 50) {
    const pattern = `%${query}%`;
    return this.db
      .select()
      .from(memoryFacts)
      .where(or(like(memoryFacts.subject, pattern), like(memoryFacts.sourceRef, pattern)))
      .orderBy(desc(memoryFacts.id))
      .limit(limit);
  }
}
