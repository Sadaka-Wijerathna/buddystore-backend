import axios from 'axios';
import prisma from '../lib/prisma';

// Target Wallets (Provided by User)
export const WALLET_TON = 'UQA9DPVbEZJ0q5mbz8jSuX0jhcASkUILxW7uQqoX-uNHH2Q2';
export const WALLET_USDT_BSC = '0x9038252f1ae98f577903ace1f45bf6d729d0fad8';
export const WALLET_USDT_TRC20 = 'TCAoaEMAPE1aGico5jQ64FEn9eR2cNafNf';
export const WALLET_USDT_APT = '0x374b7a4efb614f5bba55409f55ec4be3a7da41913ed4fdd664d7a5233b240d19';
export const WALLET_USDT_ETH = '0x9038252f1ae98f577903ace1f45bf6d729d0fad8';
export const WALLET_USDT_POLYGON = '0x9038252f1ae98f577903ace1f45bf6d729d0fad8';
export const WALLET_USDT_SOL = 'GK8sYeqphgMmvekafXL2ihnjJP5b7X6eGsRTj3z5LgMg';
export const WALLET_USDT_TON = 'UQA9DPVbEZJ0q5mbz8jSuX0jhcASkUILxW7uQqoX-uNHH2Q2';

// Approx Rates (In a real app, these should come from an API or Admin Settings)
// We'll try to fetch them from Setting table, or use defaults.
export async function getExchangeRates() {
  const settings = await prisma.setting.findMany({
    where: {
      key: { in: ['RATE_LKR_USD', 'RATE_TON_USD'] }
    }
  });

  const rates = {
    LKR_USD: 305, // 1 USD = 305 LKR
    TON_USD: 5.3,  // 1 TON = 5.3 USD
  };

  settings.forEach(s => {
    if (s.key === 'RATE_LKR_USD') rates.LKR_USD = parseFloat(s.value);
    if (s.key === 'RATE_TON_USD') rates.TON_USD = parseFloat(s.value);
  });

  return rates;
}

export class CryptoService {
  // Automated verification removed as per user request (Switching to Manual Only)
  
  static async convertLkrToCrypto(lkrAmount: number, currency: 'TON' | 'USDT'): Promise<number> {
    const rates = await getExchangeRates();
    const usdAmount = lkrAmount / rates.LKR_USD;

    if (currency === 'USDT') {
      return parseFloat(usdAmount.toFixed(2));
    } else if (currency === 'TON') {
      const tonAmount = usdAmount / rates.TON_USD;
      return parseFloat(tonAmount.toFixed(4));
    }

    return 0;
  }
}
