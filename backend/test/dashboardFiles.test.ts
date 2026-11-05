import { describe, expect, test } from 'bun:test';
import { dashboardFilenameFromPath, dashboardMatchesGroup, parseDashboardFilename, sortDashboardFiles } from '../../frontend/src/dashboardFiles';

describe('dashboard history filenames', () => {
    test('decodes only root HTML filenames without accepting nested or malformed paths', () => {
        expect(dashboardFilenameFromPath('/delivery-dashboard-oc_dev-2026-07-07.html')).toBe('delivery-dashboard-oc_dev-2026-07-07.html');
        expect(dashboardFilenameFromPath('/%E4%B8%AD%E6%96%87.html')).toBe('中文.html');
        for (const path of ['/other/file.html', '/..%2fprivate.html', '/bad%5cfile.html', '/bad%00file.html', '/bad%ZZ.html', '/file.json']) expect(dashboardFilenameFromPath(path)).toBeUndefined();
    });
    test('parses immutable group snapshot filenames', () => {
        expect(parseDashboardFilename('delivery-dashboard-oc_dev-2026-07-13-20260713T092929879-a554412c.html')).toMatchObject({
            date: '2026-07-13',
            time: '09:29:29',
            sortKey: '2026-07-13T092929879',
        });
    });

    test('keeps legacy date-only snapshots visible', () => {
        expect(parseDashboardFilename('delivery-dashboard-oc_dev-2026-07-07.html')).toMatchObject({
            date: '2026-07-07',
            time: '',
        });
    });

    test('sorts by snapshot time and matches sanitized group ids', () => {
        const files = sortDashboardFiles([
            'delivery-dashboard-oc_dev-2026-07-13-20260713T090000000-a.html',
            'delivery-dashboard-oc_dev-2026-07-13-20260713T110000000-b.html',
        ]);
        expect(files[0]).toContain('T110000000');
        expect(dashboardMatchesGroup('delivery-dashboard-oc_dev_group-2026-07-13-x.html', { chat_id: 'oc_dev/group' })).toBe(true);
    });
});
