/** nspell ships no types; this covers the surface the app uses. */
declare module "nspell" {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): NSpell;
  }
  function nspell(aff: Buffer | string, dic: Buffer | string): NSpell;
  export = nspell;
}
