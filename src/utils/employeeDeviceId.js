export const normalizeDevicePersonId = (value) => value == null ? null : String(value).trim() || null;

export async function assertUniqueDevicePersonId(model, value, employeeId) {
    const id = normalizeDevicePersonId(value);
    if (!id) return;
    const filter = { deviceEmployeeNo: id };
    if (employeeId) filter._id = { $ne: employeeId };
    // Include inactive employees and every outlet in this tenant: reusing an
    // ID can attribute delayed device events to the wrong person.
    if (await model.exists(filter)) {
        const error = new Error('Device Person ID is already assigned to another employee. Choose a unique ID.');
        error.statusCode = 409;
        throw error;
    }
}
