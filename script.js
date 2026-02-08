// 初始化 ECharts 實例
const chartDom = document.getElementById('main-chart');
const equityChartDom = document.getElementById('equity-chart'); 
const ohlcInfoDom = document.getElementById('ohlc-info');
const myChart = echarts.init(chartDom); 
const myEquityChart = echarts.init(equityChartDom); 

// 檔案路徑設定
const FILE_PATH_OI = './data/OI_三大法人.csv';
const FILE_PATH_PRICE = './data/MTX_Daily.csv';

// 顏色設定
const COLOR_UP = '#e74c3c';    // 紅
const COLOR_DOWN = '#27ae60';  // 綠
const COLOR_STOP_LOSS = '#ffffff'; // 白色圓點
const COLOR_STOP_BORDER = '#000000'; // 圓點邊框(確保在淺色底可見)

// 主程式進入點
async function initDashboard() {
    try {
        updateStatus('正在讀取數據...');
        
        const [oiData, priceData] = await Promise.all([
            fetchCsv(FILE_PATH_OI),
            fetchCsv(FILE_PATH_PRICE)
        ]);

        updateStatus('正在計算指標...');
        const mergedData = processData(oiData, priceData);

        if (mergedData.length === 0) {
            throw new Error('合併後無數據，請檢查 CSV');
        }

        // 計算策略進出場與停損點位
        const strategyData = calculateStrategyData(mergedData);
        
        // 計算權益曲線相關數據 (Equity, MDD, Sharpe)
        const equityStats = calculateEquityStats(mergedData);

        renderChart(mergedData, strategyData);
        renderEquityChart(equityStats); // 繪製損益圖
        renderTable(mergedData); 
        updateStatus(`共 ${mergedData.length} 筆資料`);

    } catch (error) {
        console.error(error);
        updateStatus(`錯誤: ${error.message}`, true);
    }
}

// 讀取 CSV
function fetchCsv(url) {
    return new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true,
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (err) => reject(err)
        });
    });
}

// 資料處理與合併
function processData(oiRaw, priceRaw) {
    const priceMap = new Map();
    priceRaw.forEach(row => {
        const date = row['Date'] ? row['Date'].trim() : null; 
        if (date) {
            priceMap.set(date, {
                open: parseFloat(row['Open']),
                close: parseFloat(row['Close']),
                low: parseFloat(row['Low']),
                high: parseFloat(row['High'])
            });
        }
    });

    const result = [];
    const dayMap = ['(日)', '(一)', '(二)', '(三)', '(四)', '(五)', '(六)']; 

    oiRaw.forEach(row => {
        const date = row['Date'] ? row['Date'].trim() : null;
        if (date && priceMap.has(date)) {
            const price = priceMap.get(date);
            const totalOI = parseFloat(row['TMF_全市場'] || 0);
            const instLongOI = parseFloat(row['TMF_多方未平倉口數'] || 0);
            const instShortOI = parseFloat(row['TMF_空方未平倉口數'] || 0);

            if (totalOI === 0) return;

            const retailLongRatio = (totalOI - instLongOI) / totalOI;
            const retailShortRatio = (totalOI - instShortOI) / totalOI;
            const retailNetRatio = retailLongRatio - retailShortRatio;

            // 計算星期幾
            const dateObj = new Date(date);
            const daySuffix = dayMap[dateObj.getUTCDay()]; 
            const formattedDate = `${date} ${daySuffix}`;

            result.push({
                date: formattedDate,
                price: price, 
                retailLong: (retailLongRatio * 100).toFixed(2),
                retailShort: (retailShortRatio * 100).toFixed(2),
                retailNet: (retailNetRatio * 100).toFixed(2)
            });
        }
    });

    // 排序
    result.sort((a, b) => {
        const dateA = a.date.split(' ')[0];
        const dateB = b.date.split(' ')[0];
        return new Date(dateA) - new Date(dateB);
    });

    return result;
}

// -----------------------------------------------------
// 核心策略邏輯 (Python Logic 轉換)
// -----------------------------------------------------
function calculateStrategyData(data) {
    const markPoints = [];   // 用於存放進出場三角形
    const stopLossDots = []; // 用於存放白色圓點 [date, value]
    const strategyMap = new Map(); // 用於 Tooltip 查詢：日期 -> { position, stopPrice }

    let position = null; // 'B' (Long) or 'S' (Short) or null
    let hh = 0; // Highest High
    let ll = 0; // Lowest Low
    let exitPrice = 0; // 目前的停利停損價
    
    // 參數設定 (與 Python 邏輯對應)
    const LONG_PERCENT = 40; 

    // 注意：Python 迴圈是從 1 到 len-1
    for (let i = 1; i < data.length - 1; i++) {
        const curr = data[i];     // 目前 K 棒 (相當於 Python 的 i / shift(0))
        const prev = data[i-1];   // 前一根 K 棒 (相當於 Python 的 i-1 / shift(1))
        const next = data[i+1];   // 下一根 K 棒 (用於標示隔日訊號)

        // 轉換數值
        const currClose = curr.price.close;
        const currOpen = curr.price.open;
        const currHigh = curr.price.high;
        const currLow = curr.price.low;

        const prevHigh = prev.price.high;
        const prevLow = prev.price.low;

        const currRetailNet = parseFloat(curr.retailNet);
        const currRetailLong = parseFloat(curr.retailLong);
        const currRetailShort = parseFloat(curr.retailShort);
        
        const prevRetailLong = parseFloat(prev.retailLong);
        const prevRetailShort = parseFloat(prev.retailShort);

        // 進場邏輯 (依照 Python)
        // 多單進場
        const entryLongSignal = (currClose > currOpen) && 
                                (currRetailNet < 0) && 
                                (currRetailLong < prevRetailLong) && 
                                (currRetailShort > prevRetailShort);

        // 空單進場
        const entryShortSignal = (currOpen > currClose) && 
                                 (currRetailNet > LONG_PERCENT) && 
                                 (currRetailLong > prevRetailLong) && 
                                 (currRetailShort < prevRetailShort);

        // 出場邏輯 (策略出場)
        const exitLongStrategy = (currOpen > currClose) && 
                                 (currRetailNet > LONG_PERCENT) && 
                                 (currRetailLong > prevRetailLong) && 
                                 (currRetailShort < prevRetailShort);

        // 目前無持倉
        if (position === null) {
            if (entryLongSignal) {
                position = 'B';
                // 多單進場：紅色三角形向上，位置 = Low * 0.99
                markPoints.push({
                    name: 'Long Entry',
                    coord: [next.date, next.price.low * 0.99],
                    symbol: 'triangle',
                    symbolRotate: 0, // 向上
                    itemStyle: { color: COLOR_UP },
                    value: 'Buy'
                });

                // 初始化停損邏輯
                hh = currHigh;
                exitPrice = currLow;
                
                // 記錄狀態供 Tooltip 使用
                strategyMap.set(next.date, { position: 'B', stopPrice: exitPrice });

            } else if (entryShortSignal) {
                position = 'S';
                // 空單進場：綠色三角形向下，位置 = High * 1.01
                markPoints.push({
                    name: 'Short Entry',
                    coord: [next.date, next.price.high * 1.01],
                    symbol: 'triangle',
                    symbolRotate: 180, // 向下
                    itemStyle: { color: COLOR_DOWN },
                    value: 'Sell'
                });

                // 初始化停損邏輯
                ll = currLow;
                exitPrice = currHigh;
                
                // 記錄狀態供 Tooltip 使用
                strategyMap.set(next.date, { position: 'S', stopPrice: exitPrice });
            }
        }
        // 持有多單
        else if (position === 'B') {
            
            // 判斷是否觸發出場 (策略出場 OR 觸及停損)
            let isExit = false;

            if (exitLongStrategy) {
                isExit = true;
            } else if (currClose < exitPrice) {
                isExit = true;
            }

            if (isExit) {
                position = null;
                // 多單出場：紅色三角形向下 (代表賣出)，位置 = High * 1.01
                markPoints.push({
                    name: 'Long Exit',
                    coord: [next.date, next.price.high * 1.01],
                    symbol: 'triangle',
                    symbolRotate: 180, // 向下
                    itemStyle: { color: COLOR_UP }, 
                    value: 'Exit'
                });
            } else {
                // 未出場，更新移動停損
                if (currClose > hh) {
                    exitPrice = Math.min(currLow, prevLow);
                }
                if (currHigh > hh) {
                    hh = currHigh;
                }
                // 記錄狀態供 Tooltip 使用
                strategyMap.set(next.date, { position: 'B', stopPrice: exitPrice });

                // 這裡沒有三角形，所以畫白點
                stopLossDots.push([next.date, exitPrice]);
            }
        }
        // 持有空單
        else if (position === 'S') {
            
            // 判斷出場
            let isExit = false;
            // 空單出場 Python 邏輯: Close > ExitPrice_Short
            if (currClose > exitPrice) {
                isExit = true;
            }

            if (isExit) {
                position = null;
                // 空單出場 (回補)：綠色三角形向上，位置 = Low * 0.99
                markPoints.push({
                    name: 'Short Exit',
                    coord: [next.date, next.price.low * 0.99],
                    symbol: 'triangle',
                    symbolRotate: 0, // 向上
                    itemStyle: { color: COLOR_DOWN }, 
                    value: 'Cover'
                });
            } else {
                // 未出場，更新移動停損
                if (currClose < ll) {
                    exitPrice = Math.max(currHigh, prevHigh);
                }
                if (currLow < ll) {
                    ll = currLow;
                }
                // 記錄狀態供 Tooltip 使用
                strategyMap.set(next.date, { position: 'S', stopPrice: exitPrice });

                // 這裡沒有三角形，所以畫白點
                stopLossDots.push([next.date, exitPrice]);
            }
        }
    }

    return { markPoints, stopLossDots, strategyMap };
}

// -----------------------------------------------------
// 計算權益曲線、MDD(%)、Rolling Sharpe
// -----------------------------------------------------
function calculateEquityStats(data) {
    const FUND = 200000;
    const FEE = 200;  // 單邊手續費
    const SIZE = 50;  // 微台點值
    const LONG_PERCENT = 40;
    const SHARPE_WINDOW = 60; // 滾動 Sharpe 週期為 60 日

    // 累積權益變數
    let equity = FUND;
    let equityLong = FUND;
    let equityShort = FUND;

    // 用於 MDD 計算
    let maxEquity = FUND;
    
    // 用於策略邏輯重現的變數
    let position = null; // 'B' or 'S'
    let hh = 0;
    let ll = 0;
    let stopPrice = 0;

    // 用於 Rolling Sharpe 計算
    let dailyReturns = [];

    // 結果陣列
    const dates = [data[0].date];
    const equityData = [FUND];
    const equityLongData = [FUND];
    const equityShortData = [FUND];
    const mddData = [0]; // 第一天 MDD% 為 0
    const sharpeData = [0]; // 第0天無 Sharpe

    // 迴圈從 1 開始
    for (let i = 1; i < data.length; i++) {
        const curr = data[i];
        const prev = data[i-1];
        
        const currOpen = curr.price.open;
        const currClose = curr.price.close;
        const currHigh = curr.price.high;
        const currLow = curr.price.low;
        
        const prevHigh = prev.price.high;
        const prevLow = prev.price.low;

        const currRetailNet = parseFloat(curr.retailNet);
        const currRetailLong = parseFloat(curr.retailLong);
        const currRetailShort = parseFloat(curr.retailShort);
        const prevRetailLong = parseFloat(prev.retailLong);
        const prevRetailShort = parseFloat(prev.retailShort);

        const entryLongSignal = (currClose > currOpen) && (currRetailNet < 0) && (currRetailLong < prevRetailLong) && (currRetailShort > prevRetailShort);
        const entryShortSignal = (currOpen > currClose) && (currRetailNet > LONG_PERCENT) && (currRetailLong > prevRetailLong) && (currRetailShort < prevRetailShort);
        const exitLongStrategy = (currOpen > currClose) && (currRetailNet > LONG_PERCENT) && (currRetailLong > prevRetailLong) && (currRetailShort < prevRetailShort);

        let dailyPnL = 0;
        let priceDiff = 0;
        let nextOpen = (i < data.length - 1) ? data[i+1].price.open : currClose; 
        
        // 執行策略
        if (position === null) {
            if (entryLongSignal) {
                position = 'B';
                hh = currHigh;
                stopPrice = currLow;
            } else if (entryShortSignal) {
                position = 'S';
                ll = currLow;
                stopPrice = currHigh;
            }
        } 
        else if (position === 'B') {
            priceDiff = nextOpen - currOpen;
            dailyPnL = priceDiff * SIZE;

            let isExit = false;
            if (exitLongStrategy || currClose < stopPrice) {
                isExit = true;
            }

            if (isExit) {
                dailyPnL -= (FEE * 2);
                position = null;
                if (exitLongStrategy && entryShortSignal) {
                     if (exitLongStrategy) { 
                         position = 'S';
                         ll = currLow;
                         stopPrice = currHigh; 
                     }
                }
            } else {
                if (currClose > hh) {
                    stopPrice = Math.min(currLow, prevLow);
                }
                if (currHigh > hh) {
                    hh = currHigh;
                }
            }
        } 
        else if (position === 'S') {
            priceDiff = currOpen - nextOpen; 
            dailyPnL = priceDiff * SIZE;

            let isExit = false;
            if (currClose > stopPrice) { 
                isExit = true;
            }

            if (isExit) {
                dailyPnL -= (FEE * 2);
                position = null;
            } else {
                if (currClose < ll) {
                    stopPrice = Math.max(currHigh, prevHigh);
                }
                if (currLow < ll) {
                    ll = currLow;
                }
            }
        }

        // 更新數據
        equity += dailyPnL;
        
        if (position === 'B' || (position === null && dailyPnL !== 0)) { 
             equityLong += dailyPnL;
        } else if (position === 'S') {
             equityShort += dailyPnL;
        }

        // 計算 MDD (%)
        if (equity > maxEquity) maxEquity = equity;
        const drawdownAbs = equity - maxEquity; // 絕對金額 (負值)
        
        // 改為百分比計算: (Drawdown / Peak) * 100
        const drawdownPercent = maxEquity !== 0 ? (drawdownAbs / maxEquity) * 100 : 0;

        // Sharpe
        const prevEquity = equity - dailyPnL;
        const dailyRet = prevEquity > 0 ? dailyPnL / prevEquity : 0;
        dailyReturns.push(dailyRet);
        
        let sharpe = 0;
        if (dailyReturns.length >= SHARPE_WINDOW) {
            const windowRets = dailyReturns.slice(-SHARPE_WINDOW);
            const mean = windowRets.reduce((a, b) => a + b, 0) / SHARPE_WINDOW;
            const variance = windowRets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / SHARPE_WINDOW;
            const std = Math.sqrt(variance);
            if (std > 0.000001) {
                sharpe = (mean / std) * Math.sqrt(252);
            }
        }

        dates.push(curr.date);
        equityData.push(Math.round(equity));
        equityLongData.push(Math.round(equityLong));
        equityShortData.push(Math.round(equityShort));
        // 儲存 MDD 百分比 (保留兩位小數)
        mddData.push(parseFloat(drawdownPercent.toFixed(2)));
        sharpeData.push(sharpe.toFixed(2));
    }

    return { dates, equityData, equityLongData, equityShortData, mddData, sharpeData };
}

// 繪製圖表 (包含策略資料)
function renderChart(data, strategyData) {
    const dates = data.map(item => item.date);
    const kLineData = data.map(item => [item.price.open, item.price.close, item.price.low, item.price.high]);
    
    const retailLongData = data.map(item => item.retailLong);
    const retailShortData = data.map(item => item.retailShort);
    const retailNetData = data.map(item => item.retailNet);

    const option = {
        textStyle: { fontFamily: 'Microsoft JhengHei, sans-serif' },
        animation: false,
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            borderColor: '#bbb',
            borderWidth: 1,
            textStyle: { color: '#333', fontSize: 13 },
            formatter: function (params) {
                if (params.length === 0) return '';

                const currentDate = params[0].axisValue;
                let result = `<div style="font-weight:bold; margin-bottom:5px; border-bottom:1px solid #eee; padding-bottom:3px;">${currentDate}</div>`;

                let netVal, longVal, shortVal;
                
                params.forEach(param => {
                    const name = param.seriesName;
                    const val = param.value;
                    if (val === undefined) return;

                    if (name === '散戶淨多空比') {
                        netVal = val;
                    } else if (name === '散戶偏多比率') {
                        longVal = val;
                    } else if (name === '散戶偏空比率') {
                        shortVal = val;
                    }
                });

                const createItem = (label, val, color) => {
                    const dot = `<span style="display:inline-block;margin-right:6px;border-radius:50%;width:10px;height:10px;background-color:${color};"></span>`;
                    return `<div style="display:flex; justify-content:space-between; min-width:180px; margin-bottom:4px;">
                                <span>${dot} ${label}</span>
                                <span style="font-weight:bold;">${val}%</span>
                            </div>`;
                };

                if (netVal !== undefined) result += createItem('散戶淨多空比', netVal, '#7f8c8d'); 
                if (longVal !== undefined) result += createItem('散戶偏多比率', longVal, COLOR_UP);
                if (shortVal !== undefined) result += createItem('散戶偏空比率', shortVal, COLOR_DOWN);

                const stratInfo = strategyData.strategyMap.get(currentDate);
                if (stratInfo) {
                    result += `<div style="margin-top:8px; border-top:1px solid #eee; padding-top:4px;"></div>`;
                    
                    const posText = stratInfo.position === 'B' ? '多單' : '空單';
                    const posColor = stratInfo.position === 'B' ? COLOR_UP : COLOR_DOWN;
                    
                    result += `<div style="display:flex; justify-content:space-between; min-width:180px; margin-bottom:4px;">
                                <span>目前持倉</span>
                                <span style="font-weight:bold; color:${posColor}">${posText}</span>
                               </div>`;
                    
                    result += `<div style="display:flex; justify-content:space-between; min-width:180px;">
                                <span>移動停利停損</span>
                                <span style="font-weight:bold; color:#333">${stratInfo.stopPrice.toLocaleString()}</span>
                               </div>`;
                }

                return result;
            }
        },
        axisPointer: { link: { xAxisIndex: 'all' } },
        legend: { show: false }, 
        grid: [
            { left: '60', right: '40', top: '40', height: '55%' }, 
            { left: '60', right: '40', top: '65%', height: '25%' }
        ],
        xAxis: [
            {
                type: 'category',
                data: dates,
                gridIndex: 0,
                axisLine: { lineStyle: { color: '#888' } },
                axisLabel: { show: false }, 
                axisPointer: { label: { show: false } }
            },
            {
                type: 'category',
                data: dates,
                gridIndex: 1,
                axisLabel: { show: true, fontSize: 12 }, 
                axisPointer: { label: { show: true } }, 
                axisTick: { show: true },
                axisLine: { show: true }
            }
        ],
        yAxis: [
            {
                scale: true,
                gridIndex: 0,
                splitLine: { show: true, lineStyle: { color: '#eee' } },
                axisLabel: { fontSize: 12 }
            },
            {
                scale: true,
                gridIndex: 1,
                splitLine: { show: true, lineStyle: { type: 'dashed' } },
                axisLabel: { formatter: '{value}%', fontSize: 11 }
            }
        ],
        dataZoom: [
            {
                type: 'inside',
                xAxisIndex: [0, 1],
                start: 80,      
                end: 100,
                zoomOnMouseWheel: false, 
                moveOnMouseWheel: false, 
                preventDefaultMouseMove: false
            },
            {
                type: 'slider', 
                xAxisIndex: [0, 1],
                bottom: 0,
                height: 20,
                start: 80,
                end: 100,
                handleSize: '100%',
                brushSelect: false
            }
        ],
        series: [
            {
                name: 'K線',
                type: 'candlestick',
                data: kLineData,
                xAxisIndex: 0,
                yAxisIndex: 0,
                itemStyle: {
                    color: COLOR_UP,
                    color0: COLOR_DOWN,
                    borderColor: COLOR_UP,
                    borderColor0: COLOR_DOWN
                },
                markPoint: {
                    symbolSize: 15,
                    label: { show: false }, 
                    data: strategyData.markPoints,
                    tooltip: {
                         formatter: function(param) {
                             return param.name + '<br/>' + param.data.coord[0] + ': ' + param.data.coord[1].toFixed(0);
                         }
                    }
                }
            },
            {
                name: '移動停損',
                type: 'scatter', 
                symbol: 'circle',
                symbolSize: 8,
                itemStyle: {
                    color: COLOR_STOP_LOSS,
                    borderColor: COLOR_STOP_BORDER,
                    borderWidth: 1.5
                },
                data: strategyData.stopLossDots,
                xAxisIndex: 0,
                yAxisIndex: 0,
                z: 10 
            },
            {
                name: '散戶淨多空比',
                type: 'bar',
                data: retailNetData,
                xAxisIndex: 1,
                yAxisIndex: 1,
                itemStyle: {
                    opacity: 0.5,
                    color: function(params) {
                        return params.value >= 0 ? COLOR_UP : COLOR_DOWN;
                    }
                }
            },
            {
                name: '散戶偏多比率',
                type: 'line',
                data: retailLongData,
                xAxisIndex: 1,
                yAxisIndex: 1,
                symbol: 'none',
                lineStyle: { width: 2, color: COLOR_UP },
                markLine: {
                    symbol: 'none',
                    label: { show: false }, 
                    lineStyle: { color: 'black', type: 'solid', width: 1 },
                    data: [ { yAxis: 40 } ]
                }
            },
            {
                name: '散戶偏空比率',
                type: 'line',
                data: retailShortData,
                xAxisIndex: 1,
                yAxisIndex: 1,
                symbol: 'none',
                lineStyle: { width: 2, color: COLOR_DOWN }
            }
        ]
    };

    myChart.setOption(option);
    
    // 連動縮放邏輯
    window.addEventListener('resize', () => { myChart.resize(); myEquityChart.resize(); });

    // 共享 Zoom
    echarts.connect([myChart, myEquityChart]);

    // 滾輪縮放邏輯
    myChart.getZr().on('mousewheel', function (params) {
        params.stop();
        const currentOption = myChart.getOption();
        if (!currentOption.dataZoom || !currentOption.dataZoom[0]) return;

        const dz = currentOption.dataZoom[0];
        const currentStart = dz.start;
        const currentEnd = dz.end;
        const currentSpan = currentEnd - currentStart; 

        const isZoomIn = params.wheelDelta > 0;
        const zoomFactor = 0.1; 
        let newSpan;

        if (isZoomIn) {
            newSpan = currentSpan * (1 - zoomFactor);
        } else {
            newSpan = currentSpan * (1 + zoomFactor);
        }

        let newStart = currentEnd - newSpan;
        if (newStart < 0) newStart = 0;
        if (currentEnd - newStart < 0.5) newStart = currentEnd - 0.5;

        if (Math.abs(newStart - currentStart) > 0.001) {
            myChart.dispatchAction({ type: 'dataZoom', start: newStart, end: currentEnd });
            myEquityChart.dispatchAction({ type: 'dataZoom', start: newStart, end: currentEnd });
        }
    });

    function updateOHLCInfo(index) {
        if (index < 0 || index >= data.length) return;
        const item = data[index];
        const p = item.price;
        const isUp = p.close >= p.open;
        const color = isUp ? COLOR_UP : COLOR_DOWN;
        const fmt = (num) => num.toLocaleString();

        ohlcInfoDom.innerHTML = `
            <span class="ohlc-item" style="color: #333; font-weight: bold; margin-right: 15px;">${item.date}</span>
            <span class="ohlc-item"><span class="ohlc-label">Open</span><span style="color:${color}">${fmt(p.open)}</span></span>
            <span class="ohlc-item"><span class="ohlc-label">High</span><span style="color:${color}">${fmt(p.high)}</span></span>
            <span class="ohlc-item"><span class="ohlc-label">Low</span><span style="color:${color}">${fmt(p.low)}</span></span>
            <span class="ohlc-item"><span class="ohlc-label">Close</span><span style="color:${color}">${fmt(p.close)}</span></span>
        `;
    }

    let currentIndex = dates.length - 1;
    updateOHLCInfo(currentIndex);

    myChart.on('updateAxisPointer', function (event) {
        if (event.dataIndex != null) {
            currentIndex = event.dataIndex;
            updateOHLCInfo(currentIndex);
        } else if (event.batch && event.batch[0]) {
            currentIndex = event.batch[0].dataIndex;
            updateOHLCInfo(currentIndex);
        }
    });

    // ===============================================
    // 鍵盤查價邏輯
    // ===============================================
    document.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            if (e.key === 'ArrowLeft') currentIndex--;
            else if (e.key === 'ArrowRight') currentIndex++;
            if (currentIndex < 0) currentIndex = 0;
            if (currentIndex >= dates.length) currentIndex = dates.length - 1;
            
            updateOHLCInfo(currentIndex);

            const targetClose = data[currentIndex].price.close;
            const point = myChart.convertToPixel({ seriesIndex: 0 }, [currentIndex, targetClose]);

            if (point) {
                myChart.dispatchAction({
                    type: 'showTip',
                    x: point[0], 
                    y: point[1] 
                });
                myEquityChart.dispatchAction({ type: 'showTip', dataIndex: currentIndex });
            }
        }
    });
}

// 新增: 繪製損益曲線圖 (已加入標題與分隔)
function renderEquityChart(stats) {
    const dates = stats.dates;
    
    const option = {
        textStyle: { fontFamily: 'Microsoft JhengHei, sans-serif' },
        animation: false,
        title: [
            { text: 'Equity', left: 'center', top: '1%', textStyle: { fontSize: 14 } },
            { text: 'Max DrawDown', left: 'center', top: '51%', textStyle: { fontSize: 14 } },
            { text: 'Rolling Sharpe', left: 'center', top: '76%', textStyle: { fontSize: 14 } }
        ],
        tooltip: {
            trigger: 'axis',
            axisPointer: { type: 'cross' },
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
            borderColor: '#bbb',
            borderWidth: 1,
            textStyle: { color: '#333', fontSize: 13 },
            
            // 修正 Tooltip 排序與分隔線邏輯
            formatter: function (params) {
                if (params.length === 0) return '';
                const currentDate = params[0].axisValue;
                
                // 建立 Map 方便取值與顏色
                const dataMap = {};
                params.forEach(p => {
                    let color = p.color;
                    // 若是區域填色(如MDD)，color 可能是物件，這裡簡化取其主色
                    if (typeof color === 'object' && color.colorStops) {
                        color = color.colorStops[0].color; 
                    }
                    dataMap[p.seriesName] = { value: p.value, color: color };
                });

                // 輔助函式：建立單行 HTML
                const createRow = (name) => {
                    const item = dataMap[name];
                    if (!item) return '';
                    
                    let displayVal = Number(item.value).toLocaleString();
                    if (name === 'MDD') {
                        // MDD 顯示為百分比，保留小數點後兩位
                        displayVal = Number(item.value).toFixed(2) + '%';
                    }
                    
                    const dot = `<span style="display:inline-block;margin-right:6px;border-radius:50%;width:10px;height:10px;background-color:${item.color};"></span>`;
                    
                    return `<div style="display:flex; justify-content:space-between; align-items:center; min-width:200px; margin-bottom:4px;">
                                <span>${dot} ${name}</span>
                                <span style="font-weight:bold;">${displayVal}</span>
                            </div>`;
                };

                // 開始構建 HTML
                // 日期 (上方分隔線由樣式處理)
                let html = `<div style="font-weight:bold; margin-bottom:6px; border-bottom:1px solid #eee; padding-bottom:4px;">${currentDate}</div>`;

                // Block 1: Equity, Long Equity, Short Equity
                let block1Html = '';
                block1Html += createRow('Equity');
                block1Html += createRow('Long Equity');
                block1Html += createRow('Short Equity');
                
                if (block1Html) {
                    html += block1Html;
                }

                // Block 2: MDD (前有分隔線)
                const rowMDD = createRow('MDD');
                if (rowMDD) {
                    if (block1Html) { // 若前一區塊有內容，才加分隔線
                        html += `<div style="margin:6px 0; border-top:1px dashed #ccc;"></div>`;
                    }
                    html += rowMDD;
                }

                // Block 3: Rolling Sharpe (前有分隔線)
                const rowSharpe = createRow('Rolling Sharpe');
                if (rowSharpe) {
                    if (block1Html || rowMDD) { // 若前有內容，加分隔線
                        html += `<div style="margin:6px 0; border-top:1px dashed #ccc;"></div>`;
                    }
                    html += rowSharpe;
                }

                return html;
            }
        },
        axisPointer: { link: { xAxisIndex: 'all' } },
        legend: { top: 25, data: ['Equity', 'Long Equity', 'Short Equity'] }, 
        grid: [
            { left: '60', right: '40', top: '8%', height: '38%' },   
            { left: '60', right: '40', top: '56%', height: '18%' },  
            { left: '60', right: '40', top: '81%', height: '14%' }   
        ],
        xAxis: [
            { 
                type: 'category', 
                data: dates, 
                gridIndex: 0, 
                axisLabel: { show: false }, 
                axisTick: { show: false },
                axisPointer: { label: { show: false } }
            },
            { 
                type: 'category', 
                data: dates, 
                gridIndex: 1, 
                axisLabel: { show: false }, 
                axisTick: { show: false },
                axisPointer: { label: { show: false } }
            },
            { 
                type: 'category', 
                data: dates, 
                gridIndex: 2, 
                axisLabel: { show: true }, 
                axisTick: { show: true },
                axisPointer: { label: { show: true } }
            }
        ],
        yAxis: [
            { 
                gridIndex: 0, 
                scale: true, 
                splitLine: { show: true, lineStyle: { color: '#eee' } },
                axisLabel: { formatter: (val) => (val/10000).toFixed(0) + '萬' }
            },
            { 
                gridIndex: 1, 
                scale: true, 
                splitLine: { show: true, lineStyle: { type: 'dashed' } },
                // MDD Y軸顯示百分比
                axisLabel: { formatter: '{value}%' } 
            },
            { 
                gridIndex: 2, 
                scale: true, 
                splitLine: { show: true, lineStyle: { type: 'dashed' } },
                axisLabel: { formatter: '{value}' } 
            }
        ],
        dataZoom: [
            { type: 'inside', xAxisIndex: [0, 1, 2], start: 80, end: 100 },
            { type: 'slider', xAxisIndex: [0, 1, 2], show: false } 
        ],
        series: [
            {
                name: 'Equity',
                type: 'line',
                data: stats.equityData,
                xAxisIndex: 0,
                yAxisIndex: 0,
                showSymbol: false,
                lineStyle: { width: 2, color: '#333' }
            },
            {
                name: 'Long Equity',
                type: 'line',
                data: stats.equityLongData,
                xAxisIndex: 0,
                yAxisIndex: 0,
                showSymbol: false,
                lineStyle: { width: 1, color: COLOR_UP, type: 'dashed' }
            },
            {
                name: 'Short Equity',
                type: 'line',
                data: stats.equityShortData,
                xAxisIndex: 0,
                yAxisIndex: 0,
                showSymbol: false,
                lineStyle: { width: 1, color: COLOR_DOWN, type: 'dashed' }
            },
            {
                name: 'MDD',
                type: 'line',
                data: stats.mddData,
                xAxisIndex: 1,
                yAxisIndex: 1,
                showSymbol: false,
                lineStyle: { width: 1, color: '#e74c3c' },
                areaStyle: { color: 'rgba(231, 76, 60, 0.2)' }
            },
            {
                name: 'Rolling Sharpe',
                type: 'line',
                data: stats.sharpeData,
                xAxisIndex: 2,
                yAxisIndex: 2,
                showSymbol: false,
                lineStyle: { width: 1.5, color: '#9b59b6' }
            }
        ]
    };
    
    myEquityChart.setOption(option);
}

// 渲染表格
function renderTable(data) {
    const tableBody = document.querySelector('#data-table tbody');
    tableBody.innerHTML = ''; 

    let recentData = [];
    const len = data.length;
    const count = 5;
    
    for(let i = len - 1; i >= Math.max(0, len - count); i--) {
        recentData.push({ item: data[i], index: i });
    }

    recentData.forEach(({ item, index }) => {
        const tr = document.createElement('tr');
        const prevItem = index > 0 ? data[index - 1] : null;

        let change = 0;
        let changeText = '-';
        let changeColor = '#333';
        
        if (prevItem) {
            change = item.price.close - prevItem.price.close;
            const changeSign = change >= 0 ? '+' : '';
            changeText = `${changeSign}${change}`;
            changeColor = change >= 0 ? COLOR_UP : COLOR_DOWN;
        }

        const createArrowCell = (currStr, prevStr, baseColor) => {
            const curr = parseFloat(currStr);
            const prev = parseFloat(prevStr);
            let arrowHtml = '';
            
            if (!isNaN(prev)) {
                if (curr > prev) {
                    arrowHtml = `<span style="color:${COLOR_UP}; font-size:12px; margin-left:4px;">▲</span>`;
                } else if (curr < prev) {
                    arrowHtml = `<span style="color:${COLOR_DOWN}; font-size:12px; margin-left:4px;">▼</span>`;
                } else {
                    arrowHtml = `<span style="color:#ccc; font-size:12px; margin-left:4px;">-</span>`;
                }
            }
            return `<span style="color:${baseColor}">${currStr}%</span>${arrowHtml}`;
        };

        const netBaseColor = parseFloat(item.retailNet) >= 0 ? COLOR_UP : COLOR_DOWN;
        const netHtml = prevItem 
            ? createArrowCell(item.retailNet, prevItem.retailNet, netBaseColor) 
            : `<span style="color:${netBaseColor}">${item.retailNet}%</span>`;

        const longHtml = prevItem 
            ? createArrowCell(item.retailLong, prevItem.retailLong, COLOR_UP)
            : `<span style="color:${COLOR_UP}">${item.retailLong}%</span>`;

        const shortHtml = prevItem 
            ? createArrowCell(item.retailShort, prevItem.retailShort, COLOR_DOWN)
            : `<span style="color:${COLOR_DOWN}">${item.retailShort}%</span>`;

        tr.innerHTML = `
            <td class="num-cell">${item.date}</td>
            <td class="num-cell" style="color:${changeColor}">${item.price.close.toLocaleString()}</td>
            <td class="num-cell" style="color:${changeColor}">${changeText}</td>
            <td class="num-cell">${netHtml}</td>
            <td class="num-cell">${longHtml}</td>
            <td class="num-cell">${shortHtml}</td>
        `;
        tableBody.appendChild(tr);
    });
}

function updateStatus(msg, isError = false) {
    const el = document.getElementById('status-msg');
    el.innerText = msg;
    el.style.color = isError ? '#c0392b' : '#7f8c8d';
}

initDashboard();