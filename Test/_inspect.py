import openpyxl

wb = openpyxl.load_workbook(r'Test/FINAL-DRAFTED-V3_Nomenclature_of_Prompt-Injection.xlsx', data_only=True)

for name in ['FINAL-DRAFTED-V2. Nomenclature', 'V1. Nomenclature of Prompt-Inje']:
    ws = wb[name]
    print('#' * 100)
    print('SHEET:', name)
    print('#' * 100)
    for i, r in enumerate(ws.iter_rows(values_only=True), start=1):
        cells = ['' if c is None else str(c).replace('\n', ' / ') for c in r]
        # trim trailing empties
        while cells and cells[-1] == '':
            cells.pop()
        if cells:
            print(f'ROW {i}: ' + ' || '.join(cells))
    print()
