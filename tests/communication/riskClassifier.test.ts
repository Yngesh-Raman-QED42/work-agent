import { describe, expect, it } from 'vitest';
import { classifyCommunicationRisk } from '../../src/agents/communication/riskClassifier.js';

describe('classifyCommunicationRisk', () => {
  it('a plain acknowledgement is routine', () => {
    expect(classifyCommunicationRisk('sure, looking into it now').risk).toBe('routine');
  });

  it('a commitment is consequential', () => {
    expect(classifyCommunicationRisk("I'll have this deployed by tomorrow").risk).toBe('consequential');
  });

  it('mentioning a client is consequential', () => {
    expect(classifyCommunicationRisk('the client asked about this feature').risk).toBe('consequential');
  });

  it('a deadline is consequential', () => {
    expect(classifyCommunicationRisk('can get this done by Friday').risk).toBe('consequential');
  });

  it('disagreement is consequential', () => {
    expect(classifyCommunicationRisk("I disagree with that approach").risk).toBe('consequential');
  });
});
