(function() {
    'use strict';

    console.log('考试酷助手 Content Script v0.1.0 加载成功。');

    // --- 常量定义 ---
    const targetTableSelector = '#xhrListDetail .table-responsive table.listGrid';
    const hiddenRowClass = 'hidden-by-script'; // 用于隐藏行的CSS类
    const duplicateHighlightClass = 'duplicate-highlight'; // 用于高亮重复的CSS类
    const exportLinkSelector = 'a.jq-dialog-exportlogexam'; // 导出链接选择器
    const firstPopupRadioSelector = '.l-dialog-body input#exportquestion'; // 第一个弹窗单选框
    const dialogButtonsSelector = '.l-dialog-buttons button'; // 弹窗按钮通用选择器
    const secondPopupContentText = '答卷文件已经生成'; // 第二个弹窗特征文本
    const secondPopupSelector = '.l-dialog-body'; // 第二个弹窗容器选择器

    // --- 状态变量 ---
    let tableFound = false;
    let tableBodyRef = null; // 表格tbody的引用
    let tableHeaderRef = null; // 表格thead的引用
    let controlPanel = null; // 控制面板UI容器
    let timeColumnIndex = -1;
    let scoreColumnIndex = -1;
    let nameColumnIndex = -1;
    let operationColumnIndex = -1; // 操作列索引
    let currentSort = { column: -1, order: 'desc' }; // 跟踪当前排序状态
    let originalDataRows = []; // 存储原始数据行 (包含DOM元素引用)
    let originalNonDataRows = []; // 存储原始非数据行
    let currentFilterDate = null; // 当前筛选的日期
    let isExporting = false; // 防止重复导出
    const scoreColumnConfig = {}; // 存储得分列的配置 (headerElement, indicator)

    // --- 辅助函数 ---
    const parseDateTime = (text) => {
        let date = new Date(text);
        if (!isNaN(date.getTime())) return date.getTime();
        // 尝试补全秒 (处理 YYYY-MM-DD HH:MM 格式)
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) {
             date = new Date(text + ':00');
             if (!isNaN(date.getTime())) return date.getTime();
        }
        // 尝试直接解析，可能包含秒或毫秒
        date = new Date(text);
        if (!isNaN(date.getTime())) return date.getTime();

        console.warn(`[parseDateTime] Failed to parse date: ${text}`);
        return NaN;
    };

    const extractNumber = (text) => {
        if (!text) return -Infinity; // 处理空或 undefined
        const cleanedText = text.trim();
        // 处理特殊文本
        if (cleanedText.includes('缺考') || cleanedText === '-' || cleanedText === '') return -Infinity;
        // 提取数字
        const match = cleanedText.match(/(-?\d+(\.\d+)?)/);
        if (match === null) return -Infinity; // 没有找到数字也视为无效
        return parseFloat(match[0]);
    };

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // 等待元素出现
    const waitForElement = (selector, container = document, timeout = 7000) => {
        return new Promise((resolve, reject) => {
            const element = container.querySelector(selector);
            if (element) {
                resolve(element);
                return;
            }

            const observer = new MutationObserver(() => {
                const element = container.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(container === document ? document.body : container, { // 监视 body 或指定容器
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                // 查找最后一次，以防在超时检查和断开连接之间元素出现
                const finalElement = container.querySelector(selector);
                if (finalElement) {
                    resolve(finalElement);
                } else {
                    reject(new Error(`Element "${selector}" not found within ${timeout}ms`));
                }
            }, timeout);
        });
    };

     // 等待包含特定文本的元素出现
    const waitForElementWithText = (selector, text, container = document, timeout = 7000) => {
        return new Promise((resolve, reject) => {
            const check = () => {
                const elements = container.querySelectorAll(selector);
                for (const element of elements) {
                    // 使用 textContent 或 innerText 检查，并去除多余空格
                    if (element.textContent?.trim().includes(text) || element.innerText?.trim().includes(text)) {
                        return element;
                    }
                }
                return null;
            };

            let element = check();
            if (element) {
                resolve(element);
                return;
            }

            const observer = new MutationObserver(() => {
                element = check();
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(container === document ? document.body : container, { // 监视 body 或指定容器
                childList: true,
                subtree: true,
                characterData: true // 监视文本内容变化
            });

            setTimeout(() => {
                observer.disconnect();
                 // 查找最后一次
                element = check();
                if (element) {
                    resolve(element);
                } else {
                    reject(new Error(`Element "${selector}" with text "${text}" not found within ${timeout}ms`));
                }
            }, timeout);
        });
    };

    // --- 核心功能函数 ---

    // 创建控制面板 UI
    function createControlPanel(container) {
        if (document.getElementById('examcooHelperControls')) {
            console.log('考试酷助手: 控制面板已存在。');
            return; // 防止重复创建
        }
        console.log('考试酷助手: 创建控制面板...');

        controlPanel = document.createElement('div');
        controlPanel.id = 'examcooHelperControls'; // 使用 ID 以便 CSS 选择

        // 日期筛选部分
        const dateFilterDiv = document.createElement('div');
        const label = document.createElement('label');
        label.textContent = '按交卷日期筛选:';
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.id = 'filterDateInput'; // 给 ID 以便访问
        const filterButton = document.createElement('button');
        filterButton.textContent = '筛选日期';
        filterButton.addEventListener('click', handleFilterClick); // 绑定事件
        const showAllButton = document.createElement('button');
        showAllButton.textContent = '显示全部';
        showAllButton.addEventListener('click', handleShowAllClick); // 绑定事件
        dateFilterDiv.appendChild(label);
        dateFilterDiv.appendChild(dateInput);
        dateFilterDiv.appendChild(filterButton);
        dateFilterDiv.appendChild(showAllButton);

        // 重复姓名与隐藏管理部分
        const manageDiv = document.createElement('div');
        const checkDuplicateButton = document.createElement('button');
        checkDuplicateButton.textContent = '检查重复姓名';
        checkDuplicateButton.addEventListener('click', handleCheckDuplicatesClick); // 绑定事件
        const restoreHiddenButton = document.createElement('button');
        restoreHiddenButton.textContent = '恢复隐藏行';
        restoreHiddenButton.addEventListener('click', handleRestoreRowsClick); // 绑定事件
        manageDiv.appendChild(checkDuplicateButton);
        manageDiv.appendChild(restoreHiddenButton);

        // 批量导出部分
        const exportDiv = document.createElement('div');
        const batchExportButton = document.createElement('button');
        batchExportButton.id = 'batchExportButton'; // 使用 ID 以便 CSS 选择和禁用
        batchExportButton.textContent = '批量导出当前页答卷';
        batchExportButton.addEventListener('click', batchExportHandler); // 绑定事件
        exportDiv.appendChild(batchExportButton);

        // 添加到控制面板
        controlPanel.appendChild(dateFilterDiv);
        controlPanel.appendChild(manageDiv);
        controlPanel.appendChild(exportDiv);

        // 将控制面板插入到表格容器之前
        if (container && container.parentNode) {
             // 尝试插入到 .table-responsive 或 table 元素之前
             const referenceNode = container.classList.contains('table-responsive') ? container : container.querySelector(targetTableSelector);
             if (referenceNode) {
                 container.parentNode.insertBefore(controlPanel, referenceNode);
                 console.log('考试酷助手: 控制面板已插入。');
             } else {
                  console.error('考试酷助手: 未能找到用于插入控制面板的参考节点。');
                  // 备选方案：直接添加到容器顶部
                  container.insertBefore(controlPanel, container.firstChild);
                  console.warn('考试酷助手: 控制面板已添加到容器顶部（备选方案）。');
             }
        } else {
            console.error('考试酷助手: 无法插入控制面板，容器或父节点无效。');
        }
    }

    // 查找列索引
    function findColumnIndices() {
        if (!tableHeaderRef) return;
        console.log('考试酷助手: 查找列索引...');

        const headerRows = tableHeaderRef.querySelectorAll('tr');
        if (headerRows.length === 0) {
            console.error('考试酷助手: 表格头部 (thead) 没有找到行 (tr)。');
            return;
        }

        // 查找函数，优先在最后一行表头查找
        const findIndex = (textToFind) => {
            let foundIndex = -1;
            const lastHeaderRow = headerRows[headerRows.length - 1];
            lastHeaderRow.querySelectorAll('th').forEach((th, colIndex) => {
                 if (th.textContent.trim().includes(textToFind)) {
                     foundIndex = colIndex;
                 }
            });
             // 如果最后一行没找到，尝试所有行 (兼容复杂表头)
             if (foundIndex === -1) {
                 for (let i = 0; i < headerRows.length; i++) {
                     headerRows[i].querySelectorAll('th').forEach((th, colIndex) => {
                         if (foundIndex === -1 && th.textContent.trim().includes(textToFind)) {
                             foundIndex = colIndex;
                         }
                     });
                     if (foundIndex !== -1) break; // 找到就停止
                 }
             }
            return foundIndex;
        };

        timeColumnIndex = findIndex('交卷时间');
        scoreColumnIndex = findIndex('得分');
        nameColumnIndex = findIndex('姓名');
        operationColumnIndex = findIndex('操作');

        if (timeColumnIndex === -1) console.warn('考试酷助手: 未能定位到“交卷时间”列。');
        if (scoreColumnIndex === -1) console.warn('考试酷助手: 未能定位到“得分”列。排序功能可能受限。');
        if (nameColumnIndex === -1) console.warn('考试酷助手: 未能定位到“姓名”列。重复姓名检查将不可用。');
        if (operationColumnIndex === -1) console.warn('考试酷助手: 未能定位到“操作”列。隐藏按钮和行类型判断可能受限。');

        console.log(`考试酷助手: 列索引结果 - 时间=${timeColumnIndex}, 得分=${scoreColumnIndex}, 姓名=${nameColumnIndex}, 操作=${operationColumnIndex}`);
    }

    // 存储原始行数据并添加隐藏按钮
    function storeOriginalRows() {
        if (!tableBodyRef) return;
        console.log('考试酷助手: 存储原始行数据...');
        originalDataRows = [];
        originalNonDataRows = [];
        const allRows = Array.from(tableBodyRef.querySelectorAll('tr'));

        allRows.forEach(row => {
            // 判断是否为数据行（更健壮的判断）
            // 1. 必须有单元格
            if (row.cells.length === 0) {
                 originalNonDataRows.push(row);
                 return;
            }
            // 2. 操作列存在且内容不含“未交”或“缺考”等关键字，且不含 js_colspan 类
            const opCell = operationColumnIndex !== -1 ? row.cells[operationColumnIndex] : null;
            const opText = opCell ? opCell.textContent.trim() : '';
            const isLikelyDataRow = opCell && !opText.includes('未交') && !opText.includes('缺考') && !row.classList.contains('js_colspan');
            // 3. 或者，如果操作列不存在，则检查是否有导出链接
            const hasExportLink = row.querySelector(exportLinkSelector) !== null;

            if (isLikelyDataRow || (!opCell && hasExportLink)) { // 主要依据操作列，备用检查导出链接
                originalDataRows.push(row);
                addHideButtonToRow(row); // 给数据行添加隐藏按钮
            } else {
                originalNonDataRows.push(row);
            }
        });
        console.log(`考试酷助手: 存储完成 - ${originalDataRows.length} 数据行, ${originalNonDataRows.length} 非数据行。`);
    }

    // 添加隐藏按钮到行
    function addHideButtonToRow(row) {
         if (operationColumnIndex === -1) return; // 未找到操作列
         const operationCell = row.cells[operationColumnIndex];
         if (operationCell && !operationCell.querySelector('.hide-row-button')) { // 防止重复添加
             const hideButton = document.createElement('span');
             hideButton.textContent = '隐藏';
             hideButton.className = 'action-button hide-row-button'; // 添加类以便识别和样式化
             hideButton.style.marginLeft = '5px'; // 增加一点间距
             hideButton.addEventListener('click', handleHideRowClick); // 绑定事件

             // 尝试在现有内容后添加，如果单元格为空则直接添加
             if (operationCell.textContent.trim() !== '') {
                operationCell.appendChild(document.createTextNode(' | ')); // 分隔符
             }
             operationCell.appendChild(hideButton);
         }
    }

    // 设置排序监听器
    function setupSortListeners() {
        if (scoreColumnIndex === -1 || !tableHeaderRef) return;
        console.log('考试酷助手: 设置得分列排序监听器...');

        const headerRows = tableHeaderRef.querySelectorAll('tr');
        let scoreHeaderElement = null;

        // 查找包含“得分”的表头单元格
        for (const row of headerRows) {
            const headers = row.querySelectorAll('th');
            if (headers.length > scoreColumnIndex && headers[scoreColumnIndex].textContent.trim().includes('得分')) {
                scoreHeaderElement = headers[scoreColumnIndex];
                break; // 找到即停止
            }
        }

        if (scoreHeaderElement) {
            scoreHeaderElement.style.cursor = 'pointer';
            scoreHeaderElement.style.userSelect = 'none'; // 防止选中文本

            // 移除旧的监听器和指示符（如果存在）
            const oldIndicator = scoreHeaderElement.querySelector('.sort-indicator');
            if (oldIndicator) oldIndicator.remove();
            if (scoreHeaderElement.__sortClickListener) {
                 scoreHeaderElement.removeEventListener('click', scoreHeaderElement.__sortClickListener);
            }

            // 创建新的指示符
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator'; // 使用 class 以便 CSS 控制
            scoreHeaderElement.appendChild(indicator);

            // 存储引用
            scoreColumnConfig.headerElement = scoreHeaderElement;
            scoreColumnConfig.indicator = indicator;

            // 添加新的点击监听器
            const newListener = () => handleScoreSortClick(); // 绑定事件
            scoreHeaderElement.addEventListener('click', newListener);
            scoreHeaderElement.__sortClickListener = newListener; // 存储引用以便移除

            console.log('考试酷助手: 得分列排序监听器和指示符已设置。');

            // 确保时间列（如果存在）没有点击效果和指示符
            if (timeColumnIndex !== -1) {
                let timeHeaderElement = null;
                 for (const row of headerRows) {
                    const headers = row.querySelectorAll('th');
                    if (headers.length > timeColumnIndex && headers[timeColumnIndex].textContent.trim().includes('交卷时间')) {
                        timeHeaderElement = headers[timeColumnIndex];
                        break;
                    }
                 }
                 if (timeHeaderElement) {
                     timeHeaderElement.style.cursor = '';
                     timeHeaderElement.style.userSelect = '';
                     const oldTimeIndicator = timeHeaderElement.querySelector('.sort-indicator');
                     if (oldTimeIndicator) oldTimeIndicator.remove();
                     if (timeHeaderElement.__sortClickListener) {
                         timeHeaderElement.removeEventListener('click', timeHeaderElement.__sortClickListener);
                         delete timeHeaderElement.__sortClickListener;
                     }
                 }
            }

        } else {
             console.warn('考试酷助手: 未能准确找到“得分”表头元素来附加监听器。');
        }
    }

    // 核心排序和显示逻辑
    function sortAndDisplayRows() {
        if (!tableBodyRef) return;
        console.log(`考试酷助手: 更新表格显示。排序: 列=${currentSort.column}, 顺序=${currentSort.order}。筛选日期: ${currentFilterDate || '无'}`);

        // 1. 从原始数据行中过滤掉已隐藏的行
        let dataRowsToSort = originalDataRows.filter(row => !row.classList.contains(hiddenRowClass));

        // 2. 应用排序逻辑 (如果指定了排序列)
        if (currentSort.column !== -1) {
            const { column: columnIndex, order } = currentSort;
            // 确定数据类型以进行正确比较
            const dataType = (columnIndex === timeColumnIndex) ? 'date' : (columnIndex === scoreColumnIndex ? 'number' : 'text');
            console.log(`考试酷助手: 按列 ${columnIndex} (${dataType}) ${order === 'asc' ? '升序' : '降序'} 排序`);

            dataRowsToSort.sort((rowA, rowB) => {
                const cellA = rowA.cells[columnIndex];
                const cellB = rowB.cells[columnIndex];
                // 处理单元格不存在的情况
                if (!cellA && !cellB) return 0;
                if (!cellA) return order === 'asc' ? 1 : -1; // 空值排在后面（升序）或前面（降序）
                if (!cellB) return order === 'asc' ? -1 : 1;

                const textA = cellA.textContent.trim();
                const textB = cellB.textContent.trim();
                let valueA, valueB;

                try {
                    if (dataType === 'date') {
                        // 时间排序：默认降序，时间相同则按得分降序
                        const timeA = parseDateTime(textA);
                        const timeB = parseDateTime(textB);
                        let comparison = 0;
                        // 处理无效日期，将其排在最后
                        if (isNaN(timeA) && isNaN(timeB)) comparison = 0;
                        else if (isNaN(timeA)) comparison = 1; // A 无效，排在 B 后面
                        else if (isNaN(timeB)) comparison = -1; // B 无效，排在 A 后面
                        else comparison = timeB - timeA; // 默认时间降序

                        // 如果时间相同，且得分列存在，则按得分降序比较
                        if (comparison === 0 && scoreColumnIndex !== -1) {
                            const scoreTextA = rowA.cells[scoreColumnIndex]?.textContent.trim() || '';
                            const scoreTextB = rowB.cells[scoreColumnIndex]?.textContent.trim() || '';
                            const scoreA = extractNumber(scoreTextA);
                            const scoreB = extractNumber(scoreTextB);
                            // 处理无效得分，将其排在最后
                            if (isNaN(scoreA) && isNaN(scoreB)) return 0;
                            if (isNaN(scoreA)) return 1;
                            if (isNaN(scoreB)) return -1;
                            return scoreB - scoreA; // 得分降序
                        }
                        // 如果是明确要求按时间升序 (理论上目前不会，但保留逻辑)
                        return order === 'asc' ? -comparison : comparison;

                    } else if (dataType === 'number') {
                        // 数字排序（主要用于得分列）
                        valueA = extractNumber(textA);
                        valueB = extractNumber(textB);
                        // 处理无效数字，将其排在最后（升序）或最前（降序）
                        if (isNaN(valueA) && isNaN(valueB)) return 0;
                        if (isNaN(valueA)) return order === 'asc' ? 1 : -1;
                        if (isNaN(valueB)) return order === 'asc' ? -1 : 1;
                        return order === 'asc' ? valueA - valueB : valueB - valueA;

                    } else {
                        // 文本排序 (备用，例如按姓名排序 - 虽然目前未实现点击姓名排序)
                        valueA = textA;
                        valueB = textB;
                        return order === 'asc' ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA);
                    }
                } catch (error) {
                    console.error(`考试酷助手: 排序比较时出错: ${error}`, rowA, rowB);
                    return 0; // 出错时保持原始顺序
                }
            });
             console.log(`考试酷助手: ${dataRowsToSort.length} 行数据排序完成。`);
        } else {
             console.log('考试酷助手: 未指定排序列，使用原始顺序（过滤隐藏行后）。');
        }

        // 3. 应用日期筛选逻辑
        let rowsToDisplay = dataRowsToSort;
        if (currentFilterDate) {
            console.log(`考试酷助手: 应用日期筛选: ${currentFilterDate}`);
            rowsToDisplay = dataRowsToSort.filter(row => {
                if (timeColumnIndex === -1) return false; // 没有时间列无法筛选
                const timeCell = row.cells[timeColumnIndex];
                if (!timeCell) return false;
                const cellDateText = timeCell.textContent.trim().split(' ')[0]; // 获取 YYYY-MM-DD 部分
                return cellDateText === currentFilterDate;
            });
            console.log(`考试酷助手: 筛选后剩余 ${rowsToDisplay.length} 行。`);
        }

        // 4. 更新 DOM 显示
        console.log('考试酷助手: 更新表格 tbody 内容...');
        try {
            // 清空 tbody
            while (tableBodyRef.firstChild) {
                tableBodyRef.removeChild(tableBodyRef.firstChild);
            }
            // 重新插入排序/筛选后的数据行 (且未被隐藏)
            rowsToDisplay.forEach(row => {
                // 再次确认未被隐藏 (理论上已过滤，双重保险)
                if (!row.classList.contains(hiddenRowClass)) {
                    tableBodyRef.appendChild(row);
                }
            });
            // 重新插入原始的非数据行 (通常是表尾合计等)
            originalNonDataRows.forEach(row => {
                 tableBodyRef.appendChild(row);
            });
            console.log(`考试酷助手: 表格 tbody 更新完成，显示 ${rowsToDisplay.length} 条数据行和 ${originalNonDataRows.length} 条非数据行。`);
        } catch (e) {
            console.error('考试酷助手: 更新表格显示时出错:', e);
        }
    }

    // 更新得分列排序指示符
    function updateScoreSortIndicator() {
        if (!scoreColumnConfig.indicator) return;
        if (currentSort.column === scoreColumnIndex) {
            scoreColumnConfig.indicator.textContent = currentSort.order === 'desc' ? '▼' : '▲';
            console.log(`考试酷助手: 得分列指示符更新为: ${scoreColumnConfig.indicator.textContent}`);
        } else {
            scoreColumnConfig.indicator.textContent = ''; // 清空指示符
            console.log('考试酷助手: 得分列指示符已清除。');
        }
    }

    // 处理得分列点击事件
    function handleScoreSortClick() {
        console.log('考试酷助手: 检测到得分列点击。');
        if (scoreColumnIndex === -1 || !tableBodyRef) return;

        if (currentSort.column === scoreColumnIndex) {
            // 如果当前已按得分排序，切换顺序
            currentSort.order = currentSort.order === 'desc' ? 'asc' : 'desc';
        } else {
            // 否则，切换到按得分排序，默认降序
            currentSort.column = scoreColumnIndex;
            currentSort.order = 'desc';
        }
        console.log(`考试酷助手: 排序状态变更为: 列=${currentSort.column}, 顺序=${currentSort.order}`);

        sortAndDisplayRows(); // 应用新的排序并更新显示
        updateScoreSortIndicator(); // 更新指示符
    }

    // 处理日期筛选按钮点击
    function handleFilterClick() {
        const dateInput = controlPanel?.querySelector('#filterDateInput');
        if (!dateInput || !tableBodyRef) {
            console.warn('考试酷助手: 无法找到日期输入框或表格主体，无法筛选。');
            return;
        }
        const selectedDate = dateInput.value; // 获取 YYYY-MM-DD 格式的日期
        console.log(`考试酷助手: 筛选日期按钮点击。选择的日期: ${selectedDate}`);

        if (selectedDate) {
            currentFilterDate = selectedDate;
            sortAndDisplayRows(); // 应用筛选并更新显示
        } else {
            // 如果用户清空了日期但点了筛选，也视为显示全部
            currentFilterDate = null;
            sortAndDisplayRows();
            console.log('考试酷助手: 未选择有效日期，显示全部。');
        }
    }

    // 处理显示全部按钮点击
    function handleShowAllClick() {
        console.log('考试酷助手: 显示全部按钮点击。');
        const dateInput = controlPanel?.querySelector('#filterDateInput');
        if (dateInput) {
            dateInput.value = ''; // 清空日期输入框
        }
        currentFilterDate = null; // 清除筛选状态
        sortAndDisplayRows(); // 恢复显示全部行（并应用当前排序）
    }

    // 处理检查重复姓名按钮点击
    function handleCheckDuplicatesClick() {
        console.log('考试酷助手: 检查重复姓名按钮点击。');
        if (nameColumnIndex === -1 || !tableBodyRef) {
            console.warn('考试酷助手: 未找到姓名列或表格主体，无法检查重复。');
            alert('错误：未能找到姓名列，无法执行此操作。');
            return;
        }

        // 清除旧的高亮
        const highlightedRows = tableBodyRef.querySelectorAll(`tr.${duplicateHighlightClass}`);
        highlightedRows.forEach(row => row.classList.remove(duplicateHighlightClass));
        console.log(`考试酷助手: 清除了 ${highlightedRows.length} 个旧高亮。`);

        const nameCounts = {};
        const duplicateNames = new Set();

        // 仅统计当前可见的数据行
        const visibleDataRows = Array.from(tableBodyRef.querySelectorAll('tr')).filter(row =>
            originalDataRows.includes(row) && // 必须是原始数据行
            !row.classList.contains(hiddenRowClass) // 且当前可见
        );
        console.log(`考试酷助手: 找到 ${visibleDataRows.length} 个可见数据行进行检查。`);

        visibleDataRows.forEach(row => {
            const nameCell = row.cells[nameColumnIndex];
            if (nameCell) {
                const name = nameCell.textContent.trim();
                if (name) { // 忽略空姓名
                    nameCounts[name] = (nameCounts[name] || 0) + 1;
                    if (nameCounts[name] > 1) {
                        duplicateNames.add(name);
                    }
                }
            }
        });

        console.log('考试酷助手: 发现的重复姓名:', Array.from(duplicateNames));

        // 高亮显示包含重复姓名的可见行
        let highlightCount = 0;
        visibleDataRows.forEach(row => {
            const nameCell = row.cells[nameColumnIndex];
            if (nameCell) {
                const name = nameCell.textContent.trim();
                if (duplicateNames.has(name)) {
                    row.classList.add(duplicateHighlightClass);
                    highlightCount++;
                }
            }
        });
        console.log(`考试酷助手: 高亮了 ${highlightCount} 行。`);
        if (duplicateNames.size > 0) {
            alert(`检查完成！发现 ${duplicateNames.size} 个重复的姓名，涉及 ${highlightCount} 行（已高亮显示）。`);
        } else {
            alert('检查完成！未在当前可见行中发现重复姓名。');
        }
    }

    // 处理恢复隐藏行按钮点击
    function handleRestoreRowsClick() {
        console.log('考试酷助手: 恢复隐藏行按钮点击。');
        if (!tableBodyRef) return;

        // 恢复隐藏
        const hiddenRows = tableBodyRef.querySelectorAll(`tr.${hiddenRowClass}`);
        let restoredCount = 0;
        hiddenRows.forEach(row => {
            // 确保只恢复原始数据行（理论上非数据行不应被隐藏）
            if (originalDataRows.includes(row)) {
                 row.classList.remove(hiddenRowClass);
                 restoredCount++;
            }
        });

        // 清除高亮
        const highlightedRows = tableBodyRef.querySelectorAll(`tr.${duplicateHighlightClass}`);
        highlightedRows.forEach(row => row.classList.remove(duplicateHighlightClass));

        console.log(`考试酷助手: 恢复了 ${restoredCount} 行，清除了 ${highlightedRows.length} 个高亮。`);

        // 重新应用排序和筛选，以确保所有行都按正确顺序显示
        sortAndDisplayRows();
        alert(`已恢复 ${restoredCount} 行，并清除了所有高亮。`);
    }

    // 处理行内隐藏按钮点击
    function handleHideRowClick(event) {
        // event.target 是点击的 <span> 按钮
        const row = event.target.closest('tr'); // 找到按钮所在的行
        if (row && originalDataRows.includes(row)) { // 确保是数据行
            row.classList.add(hiddenRowClass);
            console.log('考试酷助手: 隐藏行:', row);
            // 可选：隐藏后立即重新渲染，但这可能导致闪烁，暂时不加
            // sortAndDisplayRows();
        } else {
            console.warn('考试酷助手: 尝试隐藏非数据行或未找到行。', event.target);
        }
    }

    // --- 批量导出功能 ---

    // 处理批量导出按钮点击
    async function batchExportHandler() {
        if (isExporting) {
            alert('考试酷助手提示：\n\n正在导出中，请耐心等待当前任务完成...');
            return;
        }
        isExporting = true;
        console.log('考试酷助手: 开始批量导出...');
        const exportButton = controlPanel?.querySelector('#batchExportButton');
        if (exportButton) exportButton.disabled = true; // 禁用按钮

        try {
            if (!tableBodyRef) {
                alert('考试酷助手错误：未能找到表格内容，无法导出。');
                throw new Error('Table body not found for export.');
            }

            // 获取当前可见的数据行
            const visibleDataRows = Array.from(tableBodyRef.querySelectorAll('tr')).filter(row =>
                originalDataRows.includes(row) && // 是原始数据行
                !row.classList.contains(hiddenRowClass) // 且当前可见
            );

            if (visibleDataRows.length === 0) {
                alert('考试酷助手提示：\n\n未找到可见的数据行进行导出。请先确保有数据或清除筛选/恢复隐藏行。');
                return; // 不需要抛出错误，只是没有可导出的
            }

            console.log(`考试酷助手: 找到 ${visibleDataRows.length} 个可见数据行准备导出。`);
            const userConfirmation = confirm(`考试酷助手提示：\n\n将开始导出 ${visibleDataRows.length} 个可见答卷。\n\n导出过程中请不要操作页面，并留意浏览器弹出的下载提示或保存对话框。\n\n点击“确定”开始导出，点击“取消”中止。`);

            if (!userConfirmation) {
                 console.log('考试酷助手: 用户取消了批量导出。');
                 return;
            }

            await delay(500); // 短暂延迟

            let exportedCount = 0;
            let failedCount = 0;
            for (let i = 0; i < visibleDataRows.length; i++) {
                const row = visibleDataRows[i];
                const link = row.querySelector(exportLinkSelector);
                if (link) {
                    console.log(`考试酷助手: 处理第 ${i + 1} / ${visibleDataRows.length} 行导出...`);
                    if (exportButton) exportButton.textContent = `导出中 (${i + 1}/${visibleDataRows.length})...`; // 更新按钮文本

                    try {
                        await processExportForRow(link);
                        exportedCount++;
                        console.log(`考试酷助手: 第 ${i + 1} 行处理成功。`);
                        // 在两次成功导出之间增加显著延迟，防止浏览器阻止
                        if (i < visibleDataRows.length - 1) {
                             console.log('考试酷助手: 等待 3 秒后处理下一行...');
                             await delay(3000); // 行间延迟 3 秒
                        }
                    } catch (error) {
                        failedCount++;
                        console.error(`考试酷助手: 处理第 ${i + 1} 行时发生错误:`, error);
                        // 错误已在 processExportForRow 中提示，这里决定是否中止
                        const continueOnError = confirm(`考试酷助手错误：\n\n处理第 ${i + 1} 行（姓名：${row.cells[nameColumnIndex]?.textContent.trim() || '未知'}）时出错：\n${error.message}\n\n是否跳过此行并继续导出剩余答卷？\n点击“确定”继续，点击“取消”中止所有导出。`);
                        if (!continueOnError) {
                            console.log('考试酷助手: 用户选择中止批量导出。');
                            alert('批量导出已中止。');
                            break; // 跳出循环
                        } else {
                             console.log('考试酷助手: 用户选择跳过错误行，继续导出...');
                             // 跳过后也加一点延迟
                             await delay(1000);
                        }
                    }
                } else {
                    console.warn(`考试酷助手: 第 ${i + 1} 行未找到导出链接，已跳过。`, row);
                    failedCount++; // 视为失败
                     // 短暂延迟
                     await delay(500);
                }
            }

            // 最终结果提示
            let finalMessage = `批量导出任务完成！\n\n成功处理：${exportedCount} 行\n失败或跳过：${failedCount} 行`;
            if (failedCount > 0) {
                finalMessage += '\n\n请检查控制台（按 F12）获取失败详情。';
            }
            alert(finalMessage);
            console.log(`考试酷助手: 批量导出结束。成功: ${exportedCount}, 失败/跳过: ${failedCount}`);

        } catch (error) {
            // 捕获 batchExportHandler 自身的意外错误
            console.error('考试酷助手: 批量导出过程中发生意外错误:', error);
            alert(`考试酷助手严重错误：\n\n批量导出过程中发生意外错误，任务已中止。\n请查看控制台（按 F12）获取详细信息。\n错误: ${error.message}`);
        } finally {
            isExporting = false;
            if (exportButton) {
                exportButton.disabled = false; // 重新启用按钮
                exportButton.textContent = '批量导出当前页答卷'; // 恢复按钮文本
            }
            console.log('考试酷助手: 导出流程结束，状态已重置。');
        }
    }

    // 处理单行导出逻辑
    async function processExportForRow(linkElement) {
        const row = linkElement.closest('tr');
        const studentName = row?.cells[nameColumnIndex]?.textContent.trim() || '未知学生';
        console.log(`[ProcessExport] 开始处理行: ${studentName}`);

        try {
            // 1. 点击导出链接
            console.log('[ProcessExport] 点击导出链接...');
            linkElement.click();
            await delay(700); // 增加等待弹窗动画时间

            // 2. 处理第一个弹窗
            console.log('[ProcessExport] 等待第一个弹窗...');
            // 使用更具体的选择器定位第一个弹窗体
            const firstDialogBody = await waitForElement('.l-dialog-body:has(input#exportquestion)', document, 6000);
            console.log('[ProcessExport] 第一个弹窗找到。');

            const radio = await waitForElement(firstPopupRadioSelector, firstDialogBody, 3000);
            if (!radio.checked) { // 检查是否已选中，避免不必要点击
                radio.click();
                console.log('[ProcessExport] 点击 "只导出试题及考生答案" 单选框。');
            } else {
                 console.log('[ProcessExport] "只导出试题及考生答案" 单选框已选中。');
            }
            await delay(300); // 点击后短暂等待

            // 查找第一个弹窗的确定按钮
            console.log('[ProcessExport] 查找第一个弹窗的确定按钮...');
            const buttons1 = firstDialogBody.querySelectorAll(dialogButtonsSelector);
            const confirmButton1 = Array.from(buttons1).find(btn => btn.textContent.trim() === '确定'); // 精确匹配“确定”
            if (!confirmButton1) {
                throw new Error('未能找到第一个弹窗的“确定”按钮。');
            }
            confirmButton1.click();
            console.log('[ProcessExport] 点击第一个确定按钮。');
            await delay(800); // 等待第一个弹窗关闭和第二个弹窗出现

            // 3. 处理第二个弹窗
            console.log('[ProcessExport] 等待第二个弹窗 (包含文本)...');
            // 等待包含特定文本的第二个弹窗体
            const secondDialogBody = await waitForElementWithText(secondPopupSelector, secondPopupContentText, document, 12000); // 延长等待时间
            console.log('[ProcessExport] 第二个弹窗找到。');

            // 查找第二个弹窗的确定按钮
             console.log('[ProcessExport] 查找第二个弹窗的确定按钮...');
            const buttons2 = secondDialogBody.querySelectorAll(dialogButtonsSelector);
            const confirmButton2 = Array.from(buttons2).find(btn => btn.textContent.trim() === '确定'); // 精确匹配“确定”
             if (!confirmButton2) {
                throw new Error('未能找到第二个弹窗的“确定”按钮。');
            }
            confirmButton2.click();
            console.log('[ProcessExport] 点击第二个确定按钮 (触发下载)。');
            // 注意：点击后下载可能需要时间，这里的延迟是为了让浏览器有时间处理下载，
            // 并为 batchExportHandler 中的行间延迟留出空间。
            await delay(1500); // 下载触发后的短暂延迟

        } catch (error) {
            console.error(`[ProcessExport] 处理行 ${studentName} 时出错:`, error);
            // 重新抛出错误，以便 batchExportHandler 捕获并处理
            throw new Error(`处理 ${studentName} 的导出时失败: ${error.message}`);
        }
    }


    // --- 初始化函数 ---
    function initialize(tableElement) {
        console.log('考试酷助手: 找到目标表格，开始初始化...');
        tableFound = true;
        tableBodyRef = tableElement.querySelector('tbody');
        tableHeaderRef = tableElement.querySelector('thead');

        if (!tableBodyRef || !tableHeaderRef) {
            console.error('考试酷助手: 未能找到表格的 tbody 或 thead。初始化失败。');
            return;
        }

        // 1. 创建控制面板 UI
        const tableContainer = tableElement.closest('.table-responsive') || tableElement.parentNode;
        if (tableContainer) {
            createControlPanel(tableContainer); // 实现创建UI的逻辑
        } else {
            console.error('考试酷助手: 未能找到合适的容器来放置控制面板。');
        }

        // 2. 查找列索引
        findColumnIndices(); // 实现查找列索引的逻辑

        // 3. 存储原始行数据并添加隐藏按钮
        storeOriginalRows(); // 实现存储行和添加按钮的逻辑

        // 4. 设置排序监听器
        setupSortListeners(); // 实现给得分列添加监听器的逻辑

        // 5. 执行初始排序 (可能需要延迟)
        console.log('考试酷助手: 准备执行初始排序...');
        setTimeout(() => {
            if (timeColumnIndex !== -1) {
                currentSort = { column: timeColumnIndex, order: 'desc' }; // 默认时间降序
                console.log('考试酷助手: 执行初始时间降序排序。');
                sortAndDisplayRows(); // 实现排序和显示逻辑
            } else if (scoreColumnIndex !== -1) {
                 currentSort = { column: scoreColumnIndex, order: 'desc' }; // 备用得分降序
                 console.log('考试酷助手: 未找到时间列，执行初始得分降序排序。');
                 sortAndDisplayRows();
            } else {
                console.warn('考试酷助手: 未找到时间和得分列，无法执行初始排序。仅显示原始数据。');
                sortAndDisplayRows(); // 确保至少显示出来
            }
            updateScoreSortIndicator(); // 更新指示器状态
        }, 500); // 延迟以确保页面渲染稳定

        console.log('考试酷助手: 初始化完成。');
    }

    // --- 使用 MutationObserver 监视表格加载 ---
    console.log('考试酷助手: 开始监视 DOM 以查找目标表格...');
    const observer = new MutationObserver((mutationsList, observerInstance) => {
        if (tableFound) {
            observerInstance.disconnect(); // 已找到，停止监视
            return;
        }

        const tableElement = document.querySelector(targetTableSelector);
        if (tableElement) {
            console.log('考试酷助手: MutationObserver 发现目标表格。');
            observerInstance.disconnect(); // 停止监视
            initialize(tableElement); // 开始初始化
        }
        // 可以在这里添加对特定 mutation 的更精细检查，但通常查找元素就够了
    });

    // 开始监视 document.body 的子节点变化
    // 注意: manifest.json 中 run_at: "document_idle" 意味着 DOM 基本加载完成，
    // 但表格可能是通过 AJAX 加载的，所以仍然需要 Observer。
    observer.observe(document.body, {
        childList: true, // 监视子节点的添加或删除
        subtree: true    // 监视所有后代节点
    });

    // 可选：设置一个超时，以防万一表格永远不出现
    setTimeout(() => {
        if (!tableFound) {
            console.warn('考试酷助手: 监视超时 (15秒)，仍未找到目标表格。脚本可能无法生效。');
            observer.disconnect(); // 停止监视
        }
    }, 15000); // 15秒超时

})();
