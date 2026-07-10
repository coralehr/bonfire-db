/**
 * The documented U-shape ordering (acceptance #5). Input arrives in salience
 * rank order (BF-06's fused output order, already total via the resource_id
 * tiebreak). Odd ranks fill from the FRONT and even ranks from the BACK, so
 * rank 1 is emitted first, rank 2 last, rank 3 second, rank 4 second-to-last,
 * and so on: the highest-salience items sit at both edges of the context
 * window — where LLM attention is strongest — and the tail lands in the
 * middle. A pure function of input order, so emission is deterministic.
 */
export function orderUShape<T>(ranked: readonly T[]): readonly T[] {
  const front: T[] = [];
  const back: T[] = [];
  ranked.forEach((item, index) => {
    if (index % 2 === 0) front.push(item);
    else back.unshift(item);
  });
  return [...front, ...back];
}
