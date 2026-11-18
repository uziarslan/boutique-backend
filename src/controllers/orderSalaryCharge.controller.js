import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import { chargeOrderToSalary, loadOrderSalaryCharge } from '../services/orderSalaryCharge.service.js';
import { getEmployeeCreditSummary, normalizedEmployeeCreditLimits } from '../services/employeeCredit.service.js';

export const getOrderSalaryChargeContext = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }
  const { sale } = await loadOrderSalaryCharge(req.params.id);
  const employees = await Employee.find({ isActive: true })
    .select('name designation department salaryCreditLimits').sort({ name: 1 }).lean();
  return res.json({ success: true, data: {
    order: { _id: sale._id, transactionNumber: sale.transactionNumber, totalAmount: sale.totalAmount,
      businessDate: sale.businessDate, paymentMethod: sale.paymentMethod, items: sale.items },
    employees: employees.map((employee) => ({ _id: employee._id, name: employee.name,
      designation: employee.designation, department: employee.department,
      chargeToSalaryEnabled: normalizedEmployeeCreditLimits(employee).chargeToSalaryEnabled })),
  } });
};

export const getOrderSalaryCreditSummary = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.employeeId)) {
    return res.status(400).json({ success: false, message: 'Invalid employee ID.' });
  }
  const employee = await Employee.findOne({ _id: req.params.employeeId, isActive: true });
  if (!employee) return res.status(404).json({ success: false, message: 'Active employee not found.' });
  return res.json({ success: true, data: {
    ...await getEmployeeCreditSummary(employee), canOverride: req.user.role === 'owner',
  } });
};

export const chargeJournalOrderToSalary = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid journal entry ID.' });
  }
  try {
    const { entry, sale, advance } = await chargeOrderToSalary({
      entryId: req.params.id, ...req.body, actor: req.user, ip: req.ip,
    });
    return res.json({ success: true, message: `${sale.transactionNumber} charged to salary.`,
      data: { entry, advanceId: advance._id, saleTransactionId: sale._id } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false,
      message: error.message || 'Could not charge the order to salary.', code: error.code,
      creditSummary: error.summary, reasons: error.reasons });
  }
};
