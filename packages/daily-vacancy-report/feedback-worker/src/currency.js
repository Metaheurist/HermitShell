// Salary currencies a profile can pick, as in money.py: [code, symbol, name]. HermitShell converts salaries in
// other currencies to the picked one; "" leaves them as advertised.

export const CURRENCIES = [
  ["GBP", "£", "Pound sterling"],
  ["EUR", "€", "Euro"],
  ["USD", "$", "US dollar"],
  ["CAD", "C$", "Canadian dollar"],
  ["AUD", "A$", "Australian dollar"],
  ["NZD", "NZ$", "New Zealand dollar"],
];
const SYMBOLS = { "£": "GBP", "€": "EUR", $: "USD", US$: "USD", C$: "CAD", CA$: "CAD", A$: "AUD", AU$: "AUD", NZ$: "NZD" };
const DOLLARS = new Set(["USD", "CAD", "AUD", "NZD"]);
const SYMBOL_RE = /(?:US|CA|AU|NZ|C|A)?\$|£|€/;

// "GBP", "gbp" or "£" -> "GBP"; anything else -> "".
export function currencyCode(value) {
  const text = String(value ?? "").trim().toUpperCase();
  return CURRENCIES.some(([c]) => c === text) ? text : SYMBOLS[text] || "";
}

export function currencySymbol(code) {
  return CURRENCIES.find(([c]) => c === code)?.[1] || "";
}

// The salary icon (stats.js) for a figure such as "£45,000 - £55,000", else for the profile's currency: the
// currency's symbol in a badge, or a plain banknote.
export function moneyIcon(text, fallback = "") {
  const found = SYMBOL_RE.exec(String(text ?? ""));
  const code = found ? SYMBOLS[found[0]] : currencyCode(fallback);
  return code === "GBP" ? "money-gbp" : code === "EUR" ? "money-eur" : DOLLARS.has(code) ? "money-usd" : "coin";
}
