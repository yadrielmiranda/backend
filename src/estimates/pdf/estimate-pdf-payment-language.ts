import type { EstimatePdfLocale } from './estimate-pdf-language';

const milestones = new Map([
  ["Place order", "Realizar la orden"],
  ["Release materials", "Liberar los materiales"],
  ["Before installation", "Antes de la instalación"],
  ["After installation", "Después de la instalación"],
]);

const bases = new Map([
  ["project", "del proyecto"],
  ["material", "de los materiales"],
  ["installation", "de la instalación"],
]);

const messages = new Map([
  ["Required to place the order with the manufacturer.", "Se requiere este pago para realizar la orden con el fabricante."],
  ["Required before the materials can be picked up or delivered.", "Se requiere este pago antes de recoger los materiales o de que se entreguen."],
  ["Required before installation can be scheduled or started.", "Se requiere este pago antes de programar o iniciar la instalación."],
  ["Due after installation is completed.", "Se paga al terminar la instalación."],
  ["Payment submits the estimate for administrative order review. An administrator creates the order after reviewing the project.", "Al pagar, se envía la cotización a revisión. Un administrador creará la orden después de revisar el proyecto."],
  ["Remaining balance of the first installment for your existing order.", "Saldo pendiente de la primera cuota de tu orden."],
  ["Approved change to the project. Previous payments remain credited.", "Se aprobó el cambio en el proyecto. Los pagos anteriores siguen acreditados."],
  ["Approved project reduction. The credit is applied to the remaining balance.", "Se aprobó una reducción en el total del proyecto. El crédito se aplica al saldo pendiente."],
  ["Additional initial payment for the approved change. Previous payments remain credited.", "Pago inicial adicional por el cambio aprobado. Los pagos anteriores siguen acreditados."],
  ["Remaining payment for the approved change, according to the agreed payment plan.", "Pago pendiente por el cambio aprobado, según el plan de pagos acordado."],
  ["Approved change with no change to the project total.", "Se aprobó el cambio. El total del proyecto sigue siendo el mismo."],
  ["City Fee reduced. The difference is credited to the project balance.", "Se redujo la tasa municipal. La diferencia se acredita al saldo del proyecto."],
  ["City Fee added after the first installment. Review and accept this amount before payment. Original installments remain unchanged.", "La tasa municipal se agregó después de la primera cuota. Revisa y acepta el importe antes de pagar. Las cuotas originales conservan sus importes."],
  ["Amounts are preliminary until the included charges are finalized.", "Los importes son preliminares hasta que se confirmen los cargos incluidos."],
  ["Amounts are preliminary until the installation quote and City Fee are finalized.", "Los importes son preliminares hasta que se confirmen la cotización de instalación y la tasa municipal."],
  ["Amounts are preliminary until the installation quote is finalized.", "Los importes son preliminares hasta que se confirme la cotización de instalación."],
  ["Amounts are preliminary until the City Fee is finalized.", "Los importes son preliminares hasta que se confirme la tasa municipal."],
  ["Project total excludes the pending City Fee. It will be added as a separate adjustment; original installments remain unchanged.", "La tasa municipal está pendiente. Se sumará al total del proyecto como un ajuste separado y las cuotas originales conservarán sus importes."],
]);

export function paymentScheduleNotice(locale: EstimatePdfLocale, text: string) {
  return locale === "es" ? messages.get(text) ?? text : text;
}

export function paymentRowDescription(locale: EstimatePdfLocale, row: { description: string }) {
  return paymentScheduleNotice(locale, row.description);
}

// The API stores generated titles in English, including in historical plan snapshots.
export function paymentRowTitle(locale: EstimatePdfLocale, { title }: { title: string }) {
  if (locale !== "es") return title;
  if (title === "City Fee adjustment") return "Ajuste de la tasa municipal";
  if (title === "Outstanding balance · First installment") return "Saldo pendiente · Primera cuota";

  const parts = title.split(" · ");
  const change = /^(Material change|Change order adjustment) #(\d+)$/.exec(parts[0]);
  let prefix = "";
  if (change) {
    const label = change[1] === "Material change" ? "Cambio de materiales" : "Ajuste por cambio de orden";
    const adjustment = `${label} #${change[2]}`;
    parts.shift();
    if (!parts.length) return adjustment;
    if (parts.length === 1 && parts[0] === "No additional payment") return `${adjustment} · Sin pago adicional`;
    prefix = `${adjustment} · `;
  }

  const stage = milestones.get(parts[0]);
  if (!stage) return title;
  if (parts.length === 1) return prefix + stage;
  if (parts.length !== 2) return title;
  const terms: string[] = [];
  for (const term of parts[1].split(" + ")) {
    if (term === "permit / City Fee") {
      terms.push("permiso / tasa municipal");
      continue;
    }
    const rate = /^(\d+(?:\.\d+)?)% (project|material|installation)$/.exec(term);
    if (!rate) return title;
    terms.push(`${rate[1]}% ${bases.get(rate[2])}`);
  }
  return `${prefix}${stage} · ${terms.join(" + ")}`;
}
