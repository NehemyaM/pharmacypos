export type Role = 'admin' | 'pharmacist' | 'cashier';

export type User = {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: Role;
  pharmacist_reg_no: string;
  phone: string;
  active: number;
  last_login_at: string | null;
  created_at: string;
};

export type Settings = {
  id: 1;
  shop_name: string;
  legal_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  state_code: string;
  pincode: string;
  phone: string;
  email: string;
  gstin: string;
  pan: string;
  dl_no_form20: string;
  dl_no_form21: string;
  fssai_no: string;
  pharmacist_name: string;
  pharmacist_reg_no: string;
  invoice_prefix: string;
  return_prefix: string;
  invoice_footer: string;
  round_off_enabled: number;
  expiry_alert_days: number;
  low_stock_enabled: number;
  updated_at: string;
};

export type Product = {
  id: number;
  name: string;
  generic_name: string;
  manufacturer: string;
  category: string;
  schedule_type: 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'C' | 'C1';
  hsn_code: string;
  gst_rate: number;
  unit: string;
  pack_size: number;
  pack_label: string;
  barcode: string;
  rack: string;
  reorder_level: number;
  cold_chain: number;
  allow_loose: number;
  active: number;
  created_at: string;
  updated_at: string;
};

export type Batch = {
  id: number;
  product_id: number;
  batch_no: string;
  expiry: string;
  mrp_paise: number;
  purchase_rate_paise: number;
  sale_rate_paise: number;
  qty_units: number;
  supplier_id: number | null;
  received_at: string;
  active: number;
  created_at: string;
};

export type Sale = {
  id: number;
  invoice_no: string;
  invoice_date: string;
  customer_id: number | null;
  customer_name: string;
  customer_phone: string;
  customer_gstin: string;
  doctor_id: number | null;
  prescription_no: string;
  patient_name: string;
  patient_address: string;
  place_of_supply: string;
  is_interstate: number;
  gross_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  paid_paise: number;
  payment_mode: 'CASH' | 'UPI' | 'CARD' | 'CREDIT' | 'SPLIT';
  payment_ref: string;
  status: 'COMPLETED' | 'CANCELLED';
  cancel_reason: string;
  notes: string;
  served_by: number | null;
  pharmacist_name: string;
  created_at: string;
};

export type SaleItem = {
  id: number;
  sale_id: number;
  product_id: number;
  batch_id: number;
  product_name: string;
  manufacturer: string;
  hsn_code: string;
  schedule_type: string;
  batch_no: string;
  expiry: string;
  pack_size: number;
  qty_units: number;
  mrp_paise: number;
  rate_paise: number;
  gross_paise: number;
  discount_pct: number;
  discount_paise: number;
  taxable_paise: number;
  gst_rate: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  returned_units: number;
};

export type AuthPayload = {
  id: number;
  username: string;
  role: Role;
  full_name: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
