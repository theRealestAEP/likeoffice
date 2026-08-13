/**
 * Math.sumPrecise for test runs on a Node that predates it.
 *
 * pdf.js (bundled inside unpdf, which only e2e/export-pdf.spec.ts uses) calls
 * Math.sumPrecise in seventeen places with no feature detection. Neither Node
 * 22 on CI nor Node 24 locally has it, so every run threw a TypeError that
 * pdf.js caught in its font-sanitising path and recovered from. Text
 * extraction was unaffected — the strings come from the content stream, not
 * from glyph metrics — but the log carried two alarming "TypeError:
 * Math.sumPrecise is not a function" lines that read like a production fault,
 * and pdf.js ran its degraded-font fallback instead of its real path.
 *
 * This is TEST SETUP ONLY. The shipped app contains no PDF library at all: it
 * exports through Electron's printToPDF.
 *
 * CORRECTNESS. The proposal specifies the EXACT mathematical sum, rounded once
 * at the end — not a running total. A naive left-to-right sum gets
 * [1, 1e100, 1, -1e100] wrong (0 instead of 2), because each 1 is lost against
 * 1e100. So this uses Shewchuk's exact floating-point summation, the same
 * algorithm behind Python's math.fsum: it keeps a growing set of
 * non-overlapping partial sums whose total is exact at every step, then rounds
 * once. Checked against math.fsum as the reference — [1, 1e100, 1, -1e100] is
 * 2, [1e16, 1, 1, 1, 1, 1] is 1.0000000000000004e16 (ties-to-even, NOT the
 * ...006 you might expect), and ten 0.1s are exactly 1 where a naive sum gives
 * 0.9999999999999999.
 *
 * Also per spec: an empty iterable is -0, a non-iterable is a TypeError, and a
 * non-Number element is a TypeError (no coercion).
 *
 * ONE KNOWN DEVIATION, stated rather than papered over. If a PARTIAL sum
 * overflows past ±1.8e308 while the true total is representable — say
 * [1e308, 1e308, -1e308, -1e308], whose exact sum is 0 — the spec says 0 and
 * this returns NaN. The limitation is inherent to the double-based expansion:
 * Python's math.fsum raises OverflowError on exactly that input. It is
 * unreachable from the only caller here, pdf.js, which sums glyph sizes,
 * column widths and byte counts.
 */

/** Shewchuk's expansion sum: partials never overlap, so their total is exact. */
function exactSum(values: number[]): number {
  const partials: number[] = [];
  for (const value of values) {
    let x = value;
    let i = 0;
    for (const partial of partials) {
      let hi = partial;
      let lo = x;
      if (Math.abs(lo) > Math.abs(hi)) [hi, lo] = [lo, hi];
      // Exact two-sum: `sum` is the rounded total and `err` the bit it dropped.
      const sum = hi + lo;
      const err = lo - (sum - hi);
      if (err !== 0) partials[i++] = err;
      x = sum;
    }
    partials.length = i;
    partials.push(x);
  }
  let total = 0;
  for (const partial of partials) total += partial;
  return total;
}

export function installMathSumPrecise(): void {
  if (typeof (Math as { sumPrecise?: unknown }).sumPrecise === "function") return;

  Object.defineProperty(Math, "sumPrecise", {
    configurable: true,
    writable: true,
    value: function sumPrecise(items: Iterable<number>): number {
      if (items == null || typeof (items as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
        throw new TypeError("Math.sumPrecise: argument is not iterable");
      }
      const finite: number[] = [];
      let sawNaN = false;
      let plusInf = false;
      let minusInf = false;
      for (const item of items) {
        if (typeof item !== "number") {
          throw new TypeError(`Math.sumPrecise: ${typeof item} is not a number`);
        }
        if (Number.isNaN(item)) sawNaN = true;
        else if (item === Infinity) plusInf = true;
        else if (item === -Infinity) minusInf = true;
        else finite.push(item);
      }
      // Non-finite values decide the answer before any summing happens, and
      // opposite infinities are NaN rather than a cancellation.
      if (sawNaN || (plusInf && minusInf)) return NaN;
      if (plusInf) return Infinity;
      if (minusInf) return -Infinity;
      if (finite.length === 0) return -0;
      return exactSum(finite);
    },
  });
}
