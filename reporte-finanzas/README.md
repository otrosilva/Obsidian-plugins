Plugin para [Obsidian](https://obsidian.md) que genera un reporte visual de ingresos y gastos a partir de datos exportados con `hledger` (formato `csv expenses income período`).

# Uso

- Añadir `reporte: true` en propiedades de la nota:

```
---
reporte: true
---
```

- Por defecto se usa **80 ₽ por 1 USD**.

- Propiedades adicionales:

```
---
reporte: true
RUBUSD: 90          # ₽ por cada 1 USD
# o bien con EUR como intermedio:
RUBEUR: 95          # ₽ por cada 1 EUR
EURUSD: 0.92        # EUR por cada 1 USD
---
```

- Debajo de un separador `----`, y de un título # DATA|DATOS|CSV pega la salida del reporte en formato csv

```
----
# DATA

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  expenses
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"txnidx","date","code","description","account","amount","total"
"30","2026-01-02","","Supermercado","expenses:comida","15000.00 RUB","15000.00 RUB"
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  income
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"txnidx","date","code","description","account","amount","total"
"49","2026-01-10","","Salario","income:trabajo","-2000.00 USD","-2000.00 USD"
...

```

- Estructura del reporte generado

```
# Finanzas

## Comparativa
  Tabla con barras ASCII por mes: gasto vs ingreso

## Gastos
  - Un mes en el período → desglose por semana
  - Varios meses        → desglose por mes
  Barras proporcionales al mayor gasto de cada subcuenta
  
> Observación con totales, tipo de cambio usado y balance estimado
```

- Monedas soportadas en el CSV: RUB, USD

