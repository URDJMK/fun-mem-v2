import { describe, expect, it } from 'vitest';
import { asks, nameIn, sameName, topicsIn } from '../src/lib/listen';

describe('nameIn', () => {
  it('hears the name a person gives themselves', () => {
    expect(nameIn("I'm Theo, Nell's grandson.")).toBe('Theo');
    expect(nameIn('And I’m Nell. Hello, everyone.')).toBe('Nell');
    expect(nameIn('Hi, my name is Dorothy Peltier.')).toBe('Dorothy Peltier');
    expect(nameIn('This is Carol, her daughter.')).toBe('Carol');
  });

  it('does not mistake an ordinary word for a name', () => {
    expect(nameIn("I'm so glad we're doing this.")).toBeNull();
    expect(nameIn("I'm Okay, let's start.")).toBeNull();
    expect(nameIn('This is Great.')).toBeNull();
    expect(nameIn('Okay, it is recording.')).toBeNull();
    expect(nameIn("I'm Grandma.")).toBeNull();
  });

  it('still hears it when speech-to-text drops the "my"', () => {
    // a real transcript from the first live test
    expect(nameIn('Hello, Maya. Name is Theo.')).toBe('Theo');
    expect(nameIn("Name's Nell, by the way.")).toBe('Nell');
  });

  it('stops at the end of the name', () => {
    expect(nameIn("I'm Theo And this is fun")).toBe('Theo');
  });
});

describe('sameName', () => {
  it('matches a short name to the full one either way', () => {
    expect(sameName('Nell', 'Grandma Nell')).toBe(true);
    expect(sameName('Theo Marsh', 'theo')).toBe(true);
    expect(sameName('Carol', 'Grandma Nell')).toBe(false);
    expect(sameName('Grandma', 'Grandma Nell')).toBe(false);
  });
});

describe('topicsIn', () => {
  it('picks the topics out of an ordinary answer', () => {
    expect(
      topicsIn('I’d love to hear about your childhood in Duluth, and about your family.'),
    ).toEqual(['childhood', 'family']);
    expect(topicsIn('How you met Grandpa, and the wedding')).toContain('love');
    expect(topicsIn('her years at the telephone exchange, her first job')).toContain('work');
    expect(topicsIn('nothing in particular')).toEqual([]);
  });
});

describe('asks', () => {
  it('knows a question was asked in the asker’s own words', () => {
    expect(
      asks('So, Nell, where and when were you born?', 'Where and when were you born, {name}?'),
    ).toBe(true);
    expect(
      asks(
        'What was your mother like back then?',
        'What were your parents like when you were young?',
      ),
    ).toBe(false);
    expect(
      asks(
        'Tell me about your first job. What did it pay?',
        'What was your first job, and how much did it pay?',
      ),
    ).toBe(true);
  });

  it('is not fooled by small talk', () => {
    expect(asks('Okay, it is recording now.', 'Where and when were you born, {name}?')).toBe(false);
  });
});
