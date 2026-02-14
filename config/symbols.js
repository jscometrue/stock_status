// 야후 파이낸스 심볼 매핑
// newsSymbol: Finnhub 뉴스 조회용 (없으면 해당 항목 이벤트 skip)
module.exports = {
  items: [
    { id: 'kospi', name: '코스피지수', symbol: '^KS11', unit: 'pt', newsSymbol: null },
    { id: 'kospi200', name: '코스피200지수', symbol: '^KS200', unit: 'pt', newsSymbol: null },
    { id: 'sp500', name: 'S&P500지수', symbol: '^GSPC', unit: 'pt', newsSymbol: 'SPY' },
    { id: 'sox', name: '필라델피아반도체지수', symbol: '^SOX', unit: 'pt', newsSymbol: 'SOXX' },
    { id: 'usdkrw', name: '미국USD(원)', symbol: 'KRW=X', unit: '원', newsSymbol: null },
    { id: 'gold', name: '국제금값', symbol: 'GC=F', unit: 'USD', newsSymbol: 'GLD' },
    { id: 'brent', name: '브랜트유가격', symbol: 'BZ=F', unit: 'USD', newsSymbol: null },
    { id: 'treasury10', name: '미국10년국채가격', symbol: '^TNX', unit: '%', newsSymbol: null },
    { id: 'apple', name: '애플', symbol: 'AAPL', unit: 'USD', newsSymbol: 'AAPL' },
    { id: 'microsoft', name: '마이크로소프트', symbol: 'MSFT', unit: 'USD', newsSymbol: 'MSFT' },
    { id: 'sap', name: 'SAP', symbol: 'SAP', unit: 'EUR', newsSymbol: 'SAP' },
    { id: 'nvidia', name: '앤비디아', symbol: 'NVDA', unit: 'USD', newsSymbol: 'NVDA' },
    { id: 'gaonchips', name: '가온칩스', symbol: '399720.KQ', unit: '원', newsSymbol: null },
    { id: 'tiger_sp500_h', name: 'TIGER S&P 500(H) ETF', symbol: '448290.KS', unit: '원', newsSymbol: 'SPY' },
    { id: 'tiger_sp500', name: 'TIGER S&P 500 ETF', symbol: '360750.KS', unit: '원', newsSymbol: 'SPY' },
    { id: 'tiger_sox', name: 'Tiger 필라델피아 지수', symbol: '381180.KS', unit: '원', newsSymbol: 'SOXX' },
    { id: 'krx_gold', name: 'KRX금현물가격', symbol: '319640.KS', unit: '원', newsSymbol: null },
    { id: 'alphabet', name: '알파벳A 가격', symbol: 'GOOGL', unit: 'USD', newsSymbol: 'GOOGL' },
  ]
};
