// Shared face-descriptor math used by both enrollment (salary controller)
// and matching (attendance controller).

export const euclideanDistance = (a = [], b = []) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
        return Number.POSITIVE_INFINITY;
    }
    let s = 0;
    for (let i = 0; i < a.length; i += 1) {
        const d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
        s += d * d;
    }
    return Math.sqrt(s);
};

// Element-wise mean of N descriptors. Returns null for an empty array.
export const averageDescriptors = (descriptors = []) => {
    if (!Array.isArray(descriptors) || descriptors.length === 0) return null;
    const len = descriptors[0].length;
    const out = new Array(len).fill(0);
    for (const d of descriptors) {
        for (let i = 0; i < len; i += 1) out[i] += Number(d[i]) || 0;
    }
    for (let i = 0; i < len; i += 1) out[i] /= descriptors.length;
    return out;
};
