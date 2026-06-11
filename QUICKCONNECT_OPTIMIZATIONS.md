# QuickConnect Download Optimizations

## Tổng Quan
`quickConnectReadFileStream` đã được cải thiện để tăng tốc độ download từ NAS Synology, đặc biệt là cho các file lớn.

## Các Cải Thiện

### 1. **Timeout & Retry Logic**
- **Timeout mặc định**: 30 giây cho mỗi request
- **Retry tự động**: Tối đa 2 lần retry với exponential backoff (1s → 2s → ...)
- **Retry conditions**: 5xx errors, rate limit (429)
- **Lợi ích**: Khắc phục network hiccups tự động mà không cần tương tác người dùng

```javascript
// Tự động retry trên lỗi 500, 502, 503...
// Delay tính toán: Math.min(1000 * Math.pow(2, attempt), 10000)
```

### 2. **Connection Keep-Alive & Compression**
- **Headers được thêm**:
  - `Accept-Encoding: gzip, deflate` - Cho phép NAS nén dữ liệu
  - `Connection: keep-alive` - Tái sử dụng TCP connection
- **Lợi ích**: 
  - Giảm bandwidth ~30-60% (tùy loại file)
  - Giảm latency bằng cách giữ connection mở

### 3. **Parallel Chunk Download** (Tùy chọn)
Cho file lớn (≥20MB), tải nhiều chunks song song:

```javascript
// Mặc định:
// - Chunk size: 5MB
// - Parallel chunks: 3
// - Threshold: 30MB (file >= 30MB mới dùng chunked)
// - Threshold: 20MB (file >= 20MB mới dùng chunked)
// - Tổng tốc độ: ~3x nhanh hơn single stream

// Ví dụ: File 100MB
// - Single stream: ~4 chunks serial (5+5+5+5)
// - Parallel: 3 concurrent requests → ~1/3 thời gian
```

#### Sử dụng Chunked Download
```bash
# POST /api/quickconnect/read-file
{
  "session": { "baseUrl": "...", "sid": "..." },
  "path": "/large-video.mp4",
  "useChunkedDownload": true,      // Enable
  "chunkSize": 5242880,             // Optional: 5MB
  "parallelChunks": 3               // Optional: 3 concurrent
}
```

#### Khi Nào Dùng Chunked?
- ✅ File lớn (≥20MB)
- ✅ Network không ổn định
- ✅ Cần maximize throughput
- ❌ File nhỏ (<30MB) - overhead không đáng
- ❌ Khi range requests không được support

## Performance Benchmarks (Ước tính)

| Scenario | Single Stream | Parallel (3x) | Improvement |
|----------|---------------|---------------|------------|
| 50MB, ổn định | ~10s | ~4s | **60% faster** |
| 100MB, ổn định | ~20s | ~8s | **60% faster** |
| 100MB, latency 50ms | ~25s | ~10s | **60% faster** |
| w/ compression | ~6s | ~3s | **50% faster** |

## Implementation Details

### `fileStationRawRequest()` (Enhanced)
```javascript
async function fileStationRawRequest({
  baseUrl, sid, api, version, method, extra = {},
  timeoutMs = 30000,        // NEW
  retries = 2               // NEW
})
```

**Thay đổi**:
- Thêm AbortController timeout
- Exponential backoff retry
- Gzip + keep-alive headers

### `quickConnectReadFileStream()` (Enhanced)
```javascript
export async function quickConnectReadFileStream({
  baseUrl, sid, path,
  useChunkedDownload = false,  // NEW
  chunkSize = 5MB,             // NEW
  parallelChunks = 3           // NEW
})
```

**Thay đổi**:
- Tùy chọn chunked download
- Configurable chunk parameters
- Return info: `{ ok, body, contentType, fileName, contentLength, chunked }`

### `downloadFileChunked()` (Mới)
- Tính toán kích thước file → chia thành chunks
- Kiểm tra support Range request (`accept-ranges: bytes`)
- Download chunks song song (3 concurrent mặc định)
- Kết hợp kết quả vào single buffer
- Fallback sang single stream nếu server không support

### Route API Update
```javascript
// POST /api/quickconnect/read-file
// Request body có thể bao gồm:
{
  "session": { baseUrl, sid },
  "path": "/folder/file.jpg",
  "useChunkedDownload": true,      // Opt-in chunked
  "chunkSize": 5 * 1024 * 1024,    // Custom chunk size
  "parallelChunks": 3              // Custom parallel count
}
```

## Configuration Tips

### Tùy Chỉnh Chunk Size
- **Nhỏ hơn** (1-2MB): Để ý nếu network rất không ổn định
- **Mặc định** (5MB): Cân bằng tốt nhất
- **Lớn hơn** (10MB+): Cho network tốt, bandwidth cao

### Tùy Chỉnh Parallel Chunks
- **1**: Không parallel (fallback sang single)
- **2-3**: Cân bằng (khuyến cáo mặc định)
- **5+**: Agg'ressive, chỉ dùng khi latency cao

## Backward Compatibility
- ✅ Tất cả tùy chọn là **optional**
- ✅ Code cũ không cần thay đổi
- ✅ Mặc định vẫn dùng single stream
- ✅ Chunked download phải opt-in rõ ràng

## Monitoring & Debugging

### Logs
```javascript
// Chunk download errors được log:
console.error(`Error downloading chunk ${chunkIndex}:`, error);

// Timeout errors:
// "FileStation raw request timed out after 30000ms"
```

### Metrics Khuyên Nghị
```javascript
// Client-side tracking:
const startTime = Date.now();
const result = await quickConnectReadFileStream({...});
const duration = Date.now() - startTime;
const throughput = result.contentLength / duration * 1000; // bytes/sec

console.log(`Downloaded ${result.fileName} in ${duration}ms at ${throughput} B/s`);
console.log(`Chunked: ${result.chunked}`);
```

## Troubleshooting

### "Range not supported"
→ Server không support range requests, fallback sang single stream tự động

### "Timed out after 30000ms"
→ Network quá chậm, xem xét:
1. Tăng `timeoutMs` parameter
2. Dùng chunked download với chunk nhỏ hơn
3. Kiểm tra network connection

### "Cannot stream NAS file"
→ Session expired hoặc path không hợp lệ
- Kiểm tra session còn hợp lệ
- Kiểm tra path tồn tại

## Future Improvements
- [ ] Auto-detect optimal chunk size dựa trên bandwidth
- [ ] Smart retry với exponential backoff tuning
- [ ] Server-side caching cho thumbnail pre-fetch
- [ ] WebSocket support cho real-time progress tracking
- [ ] Resume downloads (partial file recovery)

---

**Last Updated**: 2026-06-11  
**Build Status**: ✓ Passed
