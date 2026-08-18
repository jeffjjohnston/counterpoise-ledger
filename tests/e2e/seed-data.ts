const formatDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const buildSeedData = () => {
  const now = new Date();
  const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const lastYearDate = new Date(now.getFullYear() - 1, now.getMonth(), 15);
  // Unambiguously more than a year before currentMonth in every month of the
  // year. `lastYear` is not: it lands on the 15th, so against a currentMonth
  // dated the 1st it is ~11.5 months back and classifies as short-term.
  const twoYearsAgoDate = new Date(now.getFullYear() - 2, now.getMonth(), 15);
  const lastYearStart = new Date(now.getFullYear() - 1, 0, 1);
  const lastYearEnd = new Date(now.getFullYear() - 1, 11, 31);
  const sameYearAsNow = lastMonthDate.getFullYear() === now.getFullYear();

  const amounts = {
    currentMonthIncome: 50000,
    currentMonthExpense: 12000,
    lastMonthIncome: 40000,
    lastMonthExpense: 18000,
    lastYearIncome: 30000,
    lastYearExpense: 10000,
  };

  const currentYearIncome =
    amounts.currentMonthIncome +
    (sameYearAsNow ? amounts.lastMonthIncome : 0);
  const currentYearExpense =
    amounts.currentMonthExpense +
    (sameYearAsNow ? amounts.lastMonthExpense : 0);
  const lastYearIncome =
    amounts.lastYearIncome + (sameYearAsNow ? 0 : amounts.lastMonthIncome);
  const lastYearExpense = amounts.lastYearExpense;

  return {
    dates: {
      currentMonth: formatDate(currentMonthDate),
      lastMonth: formatDate(lastMonthDate),
      lastYear: formatDate(lastYearDate),
      twoYearsAgo: formatDate(twoYearsAgoDate),
      lastYearStart: formatDate(lastYearStart),
      lastYearEnd: formatDate(lastYearEnd),
    },
    amounts,
    totals: {
      currentMonthIncome: amounts.currentMonthIncome,
      currentMonthExpense: amounts.currentMonthExpense,
      lastMonthIncome: amounts.lastMonthIncome,
      lastMonthExpense: amounts.lastMonthExpense,
      lastYearIncome,
      lastYearExpense,
      currentYearIncome,
      currentYearExpense,
      allTimeIncome:
        amounts.currentMonthIncome +
        amounts.lastMonthIncome +
        amounts.lastYearIncome,
      allTimeExpense:
        amounts.currentMonthExpense +
        amounts.lastMonthExpense +
        amounts.lastYearExpense,
    },
    transferCount: 60,
    checkingTransactionCount: 66,
    payees: {
      wholeFoods: "Whole Foods",
      acmeCorp: "Acme Corp",
    },
    securities: {
      vti: { name: "Vanguard Total Stock Market", symbol: "VTI", securityType: "etf" },
    },
    recurringRules: {
      monthlyRent: { name: "Monthly Rent", amount: 150000 },
    },
  };
};
