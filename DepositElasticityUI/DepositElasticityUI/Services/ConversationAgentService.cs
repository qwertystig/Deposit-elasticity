using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;

namespace DepositElasticity.Services
{
    public class ConversationAgentService : IConversationAgentService
    {
        private readonly HttpClient _http;
        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IConfiguration _config;
        private readonly ILogger<ConversationAgentService> _logger;
        private string? _token;
        private string? _dmsToken;

        // Background job tracker, same role as the existing execmatch trace/status store.
        private static readonly ConcurrentDictionary<string, ConversationJobStatus> _jobs = new();

        public ConversationAgentService(HttpClient http, IHttpClientFactory httpClientFactory, IConfiguration config, ILogger<ConversationAgentService> logger)
        {
            _http = http;
            _httpClientFactory = httpClientFactory;
            _config = config;
            _logger = logger;
        }

        private async Task EnsureAuthenticatedAsync()
        {
            if (!string.IsNullOrEmpty(_token)) return;

            var domain = _config["PurpleFabric:Domain"];
            var tenant = _config["PurpleFabric:Tenant"];
            var url = $"https://{domain}/accesstoken/{tenant}";

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);
            request.Headers.Add("username", _config["PurpleFabric:Username"]);
            request.Headers.Add("password", _config["PurpleFabric:Password"]);

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"Conversation Auth Failed ({response.StatusCode}): {json}");

            dynamic? data = JsonConvert.DeserializeObject(json);
            _token = data?.access_token;

            if (string.IsNullOrEmpty(_token))
                throw new Exception("Conversation auth succeeded but no access_token found.");
        }

        private void SetAuthHeaders(HttpRequestMessage request)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);
            request.Headers.Add("x-platform-workspaceid", _config["PurpleFabric:WorkspaceId"]);
        }

        public async Task<string> CreateConversationAsync(string assetId)
        {
            await EnsureAuthenticatedAsync();

            var domain = _config["PurpleFabric:Domain"];
            var url = $"https://{domain}/magicplatform/v1/genai/conversation/create";

            var payload = new
            {
                conversation_name = $"Session_{DateTime.UtcNow:yyyyMMdd_HHmmss}",
                asset_version_id = assetId
            };

            using var request = new HttpRequestMessage(HttpMethod.Post, url);
            SetAuthHeaders(request);
            request.Content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"Create Conversation Failed ({response.StatusCode}): {json}");

            dynamic? data = JsonConvert.DeserializeObject(json);
            string? convId = data?.conversation_details?.conversation_id;

            if (string.IsNullOrEmpty(convId))
                throw new Exception($"Could not find conversation_id in response. Raw: {json}");

            return convId;
        }

        public async Task<(string Reply, string MessageId, List<GeneratedFile> Files)> SendMessageAsync(
            string conversationId, string query, string? refFileId = null)
        {
            await EnsureAuthenticatedAsync();
            var domain = _config["PurpleFabric:Domain"];

            var postUrl = $"https://{domain}/magicplatform/v1/genai/conversation/addmessage";
            object payload = new { conversation_id = conversationId, query = query };

            using var request = new HttpRequestMessage(HttpMethod.Post, postUrl);
            SetAuthHeaders(request);
            request.Content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");

            var response = await _http.SendAsync(request);
            var postJson = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"Send message failed ({response.StatusCode}): {postJson}");

            dynamic? postData = JsonConvert.DeserializeObject(postJson);
            string? messageId = postData?.message_id;

            if (string.IsNullOrEmpty(messageId))
                throw new Exception($"No message_id received. Raw: {postJson}");

            var (reply, files, _) = await PollForResponseAsync(_http, domain!, conversationId, messageId, _logger);
            return (reply, messageId, files);
        }

        public async Task<(string FileRefId, string FileId, string Status)> UploadFileAsync(string conversationId, IFormFile file)
        {
            await EnsureAuthenticatedAsync();
            var domain = _config["PurpleFabric:Domain"];

            var uploadUrl = $"https://{domain}/magicplatform/v1/genai/conversation/fileupload?conversation_id={conversationId}";

            using var content = new MultipartFormDataContent();
            var streamContent = new StreamContent(file.OpenReadStream());
            streamContent.Headers.ContentType = new MediaTypeHeaderValue(
                string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType);
            content.Add(streamContent, "files", file.FileName);
            content.Add(new StringContent("UPLOAD"), "doc_source");

            using var request = new HttpRequestMessage(HttpMethod.Post, uploadUrl) { Content = content };
            SetAuthHeaders(request);

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"File upload failed ({response.StatusCode}): {json}");

            var array = JsonConvert.DeserializeObject<JArray>(json);
            var firstItem = array?.FirstOrDefault();

            string? fileRefId = firstItem?["dms_ref_id"]?.ToString() ?? firstItem?["file_ref_id"]?.ToString();
            string? fileId = firstItem?["file_id"]?.ToString() ?? firstItem?["_id"]?.ToString();
            string status = firstItem?["file_status"]?.ToString() ?? "UNKNOWN";

            return (fileRefId ?? "", fileId ?? "", status);
        }

        public async Task<bool> DeleteFileAsync(string conversationId, string fileId)
        {
            if (string.IsNullOrEmpty(fileId)) return true;

            await EnsureAuthenticatedAsync();
            var domain = _config["PurpleFabric:Domain"];

            var deleteUrl = $"https://{domain}/magicplatform/v1/genai/conversation/deletefile?conversation_id={conversationId}&file_id={fileId}";

            using var request = new HttpRequestMessage(HttpMethod.Delete, deleteUrl);
            SetAuthHeaders(request);

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("[Conversation] Delete file FAILED ({Status}): {Body}", response.StatusCode, json);
                return false;
            }

            return true;
        }

        public async Task<byte[]> DownloadGeneratedFileAsync(
    string conversationId, string messageId, string messageContentId, string fileName)
        {
            // Always get a fresh token — this runs in a different request scope
            // from when the conversation was created, so _token may be stale.
            await EnsureAuthenticatedAsync();

            var domain = _config["PurpleFabric:Domain"];
            var tenant = _config["PurpleFabric:Tenant"];
            var apiKey = _config["PurpleFabric:ApiKey"];

            // ── Step 1: Resolve file name → DMS docDataId ────────────────────────
            var resolveUrl = $"https://{domain}/magicplatform/v1/genai/conversation/filedownload/{conversationId}/{messageId}/{messageContentId}";
            var payload = new { file_names = new[] { fileName } };

            using var resolveRequest = new HttpRequestMessage(HttpMethod.Post, resolveUrl);
            SetAuthHeaders(resolveRequest); // workspace header is fine for magicplatform endpoints
            resolveRequest.Content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");

            var resolveResponse = await _http.SendAsync(resolveRequest);
            var resolveJson = await resolveResponse.Content.ReadAsStringAsync();

            _logger.LogInformation("[Conversation] filedownload resolve ({Status}): {Body}", resolveResponse.StatusCode, resolveJson);

            if (!resolveResponse.IsSuccessStatusCode)
                throw new Exception($"filedownload resolve failed ({resolveResponse.StatusCode}): {resolveJson}");

            var refIds = JsonConvert.DeserializeObject<List<string>>(resolveJson);
            var docDataId = refIds?.FirstOrDefault();

            if (string.IsNullOrEmpty(docDataId))
                throw new Exception($"No DMS ref id returned for file '{fileName}'. Raw: {resolveJson}");

            _logger.LogInformation("[Conversation] Resolved docDataId: {DocDataId}", docDataId);

            // ── Step 2: Fetch from DMS — fresh token, NO workspace header ────────
            // The DMS endpoint (/platform-dms/dms/v2/...) returns 403 when
            // x-platform-workspaceid is present. It only accepts Authorization + apikey.
            // We also force a fresh token here because the scoped service instance that
            // handles the download request is different from the one that ran the conversation.
            _token = null;
            await EnsureAuthenticatedAsync();

            var dmsUrl = $"https://{domain}/platform-dms/dms/v2/tenant/{tenant}/documents?repository=ADMIN_FABRIC_AWS&docDataId={docDataId}";

            using var dmsRequest = new HttpRequestMessage(HttpMethod.Get, dmsUrl);
            dmsRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            dmsRequest.Headers.Add("apikey", apiKey);
            // deliberately NOT calling SetAuthHeaders() — that adds x-platform-workspaceid which causes 403

            var dmsResponse = await _http.SendAsync(dmsRequest);

            if (!dmsResponse.IsSuccessStatusCode)
            {
                var errBody = await dmsResponse.Content.ReadAsStringAsync();
                _logger.LogError("[Conversation] DMS fetch failed ({Status}): {Body} — docDataId={DocDataId}",
                    dmsResponse.StatusCode, errBody, docDataId);
                throw new Exception($"DMS document fetch failed ({dmsResponse.StatusCode}): {errBody}. docDataId={docDataId}, tenant={tenant}.");
            }

            _logger.LogInformation("[Conversation] DMS fetch succeeded for docDataId={DocDataId}", docDataId);
            return await dmsResponse.Content.ReadAsByteArrayAsync();
        }

        public async Task<(string Reply, string FileId)> SendMessageWithAttachmentAsync(
            string conversationId, string query, IFormFile file, string? previousFileId)
        {
            if (!string.IsNullOrEmpty(previousFileId))
            {
                await DeleteFileAsync(conversationId, previousFileId);
                await Task.Delay(1000);
            }

            var (fileRefId, fileId, status) = await UploadFileAsync(conversationId, file);

            var effectiveQuery = string.IsNullOrWhiteSpace(query)
                ? "Please review the attached file and provide your analysis."
                : query;

            var (reply, _, _) = await SendMessageAsync(conversationId, effectiveQuery, null);
            return (reply, fileId);
        }

        /// <summary>
        /// Starts the conversation send (with or without a file) as a detached background task and
        /// returns immediately. Uses IHttpClientFactory.CreateClient() for the background work —
        /// deliberately NOT the injected, request-scoped _http field, because that gets disposed the
        /// moment the triggering HTTP request ends, which is the exact ObjectDisposedException we
        /// hit previously. The factory-created client has no such lifetime tie.
        ///
        /// FIXED: now captures Files + MessageId from the worker's SendMessageAsync return (both
        /// were previously discarded — files always returned empty from BackgroundConversationWorker,
        /// and MessageId was never captured at all — which is why the UI never showed a download link
        /// even when the agent's artifacts_generated.files had a real entry).
        /// </summary>
        public void StartBackgroundSend(string traceId, string conversationId, string query,
            byte[]? fileBytes, string? fileName, string? contentType, string? previousFileId)
        {
            _jobs[traceId] = new ConversationJobStatus { Status = "PENDING" };

            var domain = _config["PurpleFabric:Domain"];
            var apiKey = _config["PurpleFabric:ApiKey"];
            var username = _config["PurpleFabric:Username"];
            var password = _config["PurpleFabric:Password"];
            var workspaceId = _config["PurpleFabric:WorkspaceId"];
            var tenant = _config["PurpleFabric:Tenant"];
            var loggerRef = _logger;
            var jobsRef = _jobs;
            var factory = _httpClientFactory;

            _ = Task.Run(async () =>
            {
                using var bgHttp = factory.CreateClient();
                bgHttp.Timeout = TimeSpan.FromMinutes(10);

                var worker = new BackgroundConversationWorker(bgHttp, domain!, tenant!, apiKey!, username!, password!, workspaceId!, loggerRef);

                try
                {
                    string reply;
                    string? newFileId = null;
                    List<GeneratedFile> files = new();
                    string? completedMessageId = null;

                    if (fileBytes != null && fileName != null)
                    {
                        var (r, fid) = await worker.SendMessageWithAttachmentBytesAsync(conversationId, query, fileBytes, fileName, contentType, previousFileId);
                        reply = r;
                        newFileId = fid;
                        // Attachment path's internal SendMessageAsync call doesn't currently
                        // surface messageId/files back through this tuple — attachments flow
                        // doesn't produce artifacts_generated documents in our current use cases,
                        // so this is left as-is (files stays empty) rather than over-engineering
                        // a path that isn't exercised by BriefAlum today.
                    }
                    else
                    {
                        var (r, f, msgId) = await worker.SendMessageAsync(conversationId, query);
                        reply = r;
                        files = f;
                        completedMessageId = msgId;
                    }

                    jobsRef[traceId] = new ConversationJobStatus
                    {
                        Status = "COMPLETED",
                        Reply = reply,
                        NewFileId = newFileId,
                        Files = files,
                        MessageId = completedMessageId
                    };
                }
                catch (Exception ex)
                {
                    loggerRef.LogError(ex, "[Conversation] Background job {TraceId} failed", traceId);
                    jobsRef[traceId] = new ConversationJobStatus { Status = "FAILED", Error = ex.Message };
                }
            });
        }

        public ConversationJobStatus? GetJobStatus(string traceId)
        {
            return _jobs.TryGetValue(traceId, out var status) ? status : null;
        }

        /// <summary>
        /// Separate auth path for the standalone DMS document-fetch API. NOTE: not actually needed
        /// for the BriefAlum download flow — DownloadGeneratedFileAsync (via SetAuthHeaders/_token)
        /// already handles both the filedownload resolve call and the DMS fetch call correctly.
        /// Left in place only in case a future use case needs a document lookup that isn't tied to
        /// an existing conversation message (e.g. a raw docDataId with no known messageId).
        /// </summary>
        private async Task EnsureDmsAuthenticatedAsync()
        {
            if (!string.IsNullOrEmpty(_dmsToken)) return;

            var domain = _config["PurpleFabric:Domain"];
            var tenant = _config["PurpleFabric:Tenant"];
            var url = $"https://{domain}/accesstoken/{tenant}";

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);
            request.Headers.Add("username", _config["PurpleFabric:Username"]);
            request.Headers.Add("password", _config["PurpleFabric:Password"]);

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"DMS Auth Failed ({response.StatusCode}): {json}");

            dynamic? data = JsonConvert.DeserializeObject(json);
            _dmsToken = data?.access_token;

            if (string.IsNullOrEmpty(_dmsToken))
                throw new Exception("DMS auth succeeded but no access_token found.");
        }

        public async Task<(byte[] Bytes, string ContentType, string FileName)> FetchDmsDocumentAsync(string docDataId)
        {
            await EnsureDmsAuthenticatedAsync();

            var domain = _config["PurpleFabric:Domain"];
            var tenant = _config["PurpleFabric:Tenant"];
            var url = $"https://{domain}/platform-dms/dms/v2/tenant/{tenant}/documents?repository=ADMIN_FABRIC_AWS&docDataId={docDataId}";

            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _dmsToken);
            request.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);

            var response = await _http.SendAsync(request);

            if (!response.IsSuccessStatusCode)
            {
                var errBody = await response.Content.ReadAsStringAsync();

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    _dmsToken = null;
                    await EnsureDmsAuthenticatedAsync();

                    using var retryRequest = new HttpRequestMessage(HttpMethod.Get, url);
                    retryRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _dmsToken);
                    retryRequest.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);

                    var retryResponse = await _http.SendAsync(retryRequest);
                    if (!retryResponse.IsSuccessStatusCode)
                    {
                        var retryErr = await retryResponse.Content.ReadAsStringAsync();
                        throw new Exception($"DMS document fetch failed after reauth ({retryResponse.StatusCode}): {retryErr}. docDataId={docDataId}");
                    }

                    var retryBytes = await retryResponse.Content.ReadAsByteArrayAsync();
                    var retryContentType = retryResponse.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
                    var retryFileName = ExtractFileNameFromDisposition(retryResponse) ?? $"{docDataId}.pdf";
                    return (retryBytes, retryContentType, retryFileName);
                }

                throw new Exception($"DMS document fetch failed ({response.StatusCode}): {errBody}. docDataId={docDataId}");
            }

            var bytes = await response.Content.ReadAsByteArrayAsync();
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "application/octet-stream";
            var fileName = ExtractFileNameFromDisposition(response) ?? $"{docDataId}.pdf";

            return (bytes, contentType, fileName);
        }

        private static string? ExtractFileNameFromDisposition(HttpResponseMessage response)
        {
            var disposition = response.Content.Headers.ContentDisposition;
            return disposition?.FileNameStar ?? disposition?.FileName?.Trim('"');
        }

        private async Task<(string Reply, List<GeneratedFile> Files, string MessageContentId)> PollForResponseAsync(
            HttpClient http, string domain, string conversationId, string messageId, ILogger logger)
        {
            const int maxAttempts = 400;
            bool reauthAttempted = false;

            for (int i = 0; i < maxAttempts; i++)
            {
                await Task.Delay(3000);

                var getUrl = $"https://{domain}/magicplatform/v1/genai/conversation/response/{conversationId}/{messageId}";
                using var getRequest = new HttpRequestMessage(HttpMethod.Get, getUrl);
                getRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
                getRequest.Headers.Add("apikey", _config["PurpleFabric:ApiKey"]);
                getRequest.Headers.Add("x-platform-workspaceid", _config["PurpleFabric:WorkspaceId"]);

                var getResponse = await http.SendAsync(getRequest);
                var getJson = await getResponse.Content.ReadAsStringAsync();

                logger.LogInformation("[Conversation] Poll attempt {Attempt} ({Status}): {Body}", i + 1, getResponse.StatusCode, getJson);

                bool looksLikeHtml = getJson.TrimStart().StartsWith("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
                                      || getJson.TrimStart().StartsWith("<html", StringComparison.OrdinalIgnoreCase);

                if ((getResponse.StatusCode == System.Net.HttpStatusCode.Unauthorized || looksLikeHtml) && !reauthAttempted)
                {
                    logger.LogWarning("[Conversation] Poll got non-JSON/401 response — re-authenticating once and retrying.");
                    reauthAttempted = true;
                    _token = null;
                    await EnsureAuthenticatedAsync();
                    continue;
                }

                if (!getResponse.IsSuccessStatusCode || looksLikeHtml) continue;

                var data = JsonConvert.DeserializeObject<JObject>(getJson);
                var contentArray = data?["message_content"] as JArray;
                var content = contentArray?.FirstOrDefault();
                string? status = content?["status"]?.ToString();

                if (status == "COMPLETED")
                {
                    string reply = content?["response"]?.ToString() ?? "No text found in response field.";
                    string msgContentId = content?["message_content_id"]?.ToString() ?? "";

                    var files = new List<GeneratedFile>();
                    var filesArray = content?["artifacts_generated"]?["files"] as JArray;
                    if (filesArray != null)
                    {
                        foreach (var f in filesArray)
                        {
                            var fileStatus = f["status"]?.ToString();
                            if (fileStatus == "created" || fileStatus == "not_modified")
                            {
                                files.Add(new GeneratedFile
                                {
                                    FileName = f["file_name"]?.ToString() ?? "",
                                    MimeType = f["mime_type"]?.ToString() ?? "",
                                    MessageContentId = msgContentId
                                });
                            }
                        }
                    }

                    return (reply, files, msgContentId);
                }

                if (status == "FAILED" || status == "ERROR")
                    throw new Exception($"Agent returned failure status. Raw: {getJson}");
            }

            return ("The agent timed out. Please try again.", new List<GeneratedFile>(), "");
        }
    }

    /// <summary>
    /// Self-contained worker for background sends. Holds its own HttpClient (from
    /// IHttpClientFactory, independent of any request scope) and its own auth token for the
    /// lifetime of a single background job — never touches the outer service's scoped _http.
    ///
    /// FIXED: SendMessageAsync now returns messageId as the 3rd tuple element (previously it
    /// only returned MessageContentId, and PollForResponseAsync's COMPLETED branch always
    /// returned an empty files list instead of parsing artifacts_generated.files like the
    /// outer class's identical method already did).
    /// </summary>
    internal class BackgroundConversationWorker
    {
        private readonly HttpClient _http;
        private readonly string _domain, _tenant, _apiKey, _username, _password, _workspaceId;
        private readonly ILogger _logger;
        private string? _token;

        public BackgroundConversationWorker(HttpClient http, string domain, string tenant, string apiKey,
            string username, string password, string workspaceId, ILogger logger)
        {
            _http = http;
            _domain = domain; _tenant = tenant; _apiKey = apiKey;
            _username = username; _password = password; _workspaceId = workspaceId;
            _logger = logger;
        }

        private async Task EnsureAuthenticatedAsync()
        {
            if (!string.IsNullOrEmpty(_token)) return;

            var url = $"https://{_domain}/accesstoken/{_tenant}";
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("apikey", _apiKey);
            request.Headers.Add("username", _username);
            request.Headers.Add("password", _password);

            var response = await _http.SendAsync(request);
            var json = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"[bg] Conversation Auth Failed ({response.StatusCode}): {json}");

            dynamic? data = JsonConvert.DeserializeObject(json);
            _token = data?.access_token;

            if (string.IsNullOrEmpty(_token))
                throw new Exception("[bg] Conversation auth succeeded but no access_token found.");
        }

        private void SetAuthHeaders(HttpRequestMessage request)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.Add("apikey", _apiKey);
            request.Headers.Add("x-platform-workspaceid", _workspaceId);
        }

        public async Task<(string Reply, string FileId)> SendMessageWithAttachmentBytesAsync(
    string conversationId, string query, byte[] fileBytes, string fileName, string? contentType, string? previousFileId)
        {
            await EnsureAuthenticatedAsync();

            if (!string.IsNullOrEmpty(previousFileId))
            {
                await DeleteFileAsync(conversationId, previousFileId);
                await Task.Delay(1000);
            }

            // ── Step 1: Upload the file ───────────────────────────────────────────
            var uploadUrl = $"https://{_domain}/magicplatform/v1/genai/conversation/fileupload?conversation_id={conversationId}";

            using var content = new MultipartFormDataContent();
            var byteContent = new ByteArrayContent(fileBytes);
            byteContent.Headers.ContentType = new MediaTypeHeaderValue(
                string.IsNullOrEmpty(contentType) ? "application/octet-stream" : contentType);
            content.Add(byteContent, "files", fileName);
            content.Add(new StringContent("UPLOAD"), "doc_source");

            using var uploadRequest = new HttpRequestMessage(HttpMethod.Post, uploadUrl) { Content = content };
            SetAuthHeaders(uploadRequest);

            var uploadResponse = await _http.SendAsync(uploadRequest);
            var uploadJson = await uploadResponse.Content.ReadAsStringAsync();

            if (!uploadResponse.IsSuccessStatusCode)
                throw new Exception($"[bg] File upload failed ({uploadResponse.StatusCode}): {uploadJson}");

            var array = JsonConvert.DeserializeObject<JArray>(uploadJson);
            var firstItem = array?.FirstOrDefault();
            string? fileId = firstItem?["file_id"]?.ToString() ?? firstItem?["_id"]?.ToString();

            _logger.LogInformation("[bg] File uploaded — fileId={FileId}. Polling for KB_CREATION_COMPLETED.", fileId);

            // ── Step 2: Poll conversation/details until file is KB_CREATION_COMPLETED ──
            // The platform indexes the uploaded file asynchronously. The file_content array
            // inside the conversation details response contains a file_status field per file.
            // We poll until we see KB_CREATION_COMPLETED (or hit the timeout).
            await WaitForFileIndexingAsync(conversationId, fileId);

            // ── Step 3: Send the query ────────────────────────────────────────────
            var effectiveQuery = string.IsNullOrWhiteSpace(query)
                ? "Please review the attached file and provide your analysis."
                : query;

            _logger.LogInformation("[bg] File ready — sending query for conversation {ConvId}.", conversationId);
            var (reply, _, _) = await SendMessageAsync(conversationId, effectiveQuery);
            return (reply, fileId ?? "");
        }

        /// <summary>
        /// Polls GET /magicplatform/v1/genai/conversation/details/{conversationId}
        /// until the uploaded file's file_status is KB_CREATION_COMPLETED.
        /// Polls every 5 seconds, times out after 3 minutes (36 attempts).
        /// Headers: Authorization Bearer token + apikey (no workspace header — GET request).
        /// </summary>
        private async Task WaitForFileIndexingAsync(string conversationId, string? fileId)
        {
            const int maxAttempts = 36;
            const int pollIntervalMs = 5000;

            var detailsUrl = $"https://{_domain}/magicplatform/v1/genai/conversation/details/{conversationId}";

            for (int i = 0; i < maxAttempts; i++)
            {
                await Task.Delay(pollIntervalMs);

                using var request = new HttpRequestMessage(HttpMethod.Get, detailsUrl);
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", _token);
                request.Headers.Add("apikey", _apiKey);

                HttpResponseMessage response;
                try
                {
                    response = await _http.SendAsync(request);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[bg] WaitForFileIndexing poll {Attempt} — network error: {Msg}", i + 1, ex.Message);
                    continue;
                }

                if (!response.IsSuccessStatusCode)
                {
                    _logger.LogWarning("[bg] WaitForFileIndexing poll {Attempt} — non-success {Status}", i + 1, response.StatusCode);
                    continue;
                }

                var json = await response.Content.ReadAsStringAsync();
                _logger.LogInformation("[bg] WaitForFileIndexing poll {Attempt}: {Body}", i + 1, json);

                try
                {
                    var data = JsonConvert.DeserializeObject<JObject>(json);

                    // API returns "file_details" — not "file_content"
                    var fileContentArray = data?["file_details"] as JArray;
                    if (fileContentArray == null || fileContentArray.Count == 0)
                    {
                        _logger.LogInformation("[bg] WaitForFileIndexing poll {Attempt} — file_details empty, waiting.", i + 1);
                        continue;
                    }

                    JToken? fileEntry = null;
                    if (!string.IsNullOrEmpty(fileId))
                    {
                        fileEntry = fileContentArray.FirstOrDefault(f =>
                            f["file_id"]?.ToString() == fileId ||
                            f["_id"]?.ToString() == fileId);
                    }
                    fileEntry ??= fileContentArray.LastOrDefault();

                    var fileStatus = fileEntry?["file_status"]?.ToString();
                    _logger.LogInformation("[bg] WaitForFileIndexing poll {Attempt} — file_status={Status}", i + 1, fileStatus);

                    if (string.Equals(fileStatus, "KB_CREATION_COMPLETED", StringComparison.OrdinalIgnoreCase))
                    {
                        _logger.LogInformation("[bg] File indexing complete after {Attempts} polls.", i + 1);
                        return;
                    }

                    if (string.Equals(fileStatus, "FAILED", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(fileStatus, "ERROR", StringComparison.OrdinalIgnoreCase))
                    {
                        _logger.LogWarning("[bg] File indexing failed with status {Status} — proceeding anyway.", fileStatus);
                        return;
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[bg] WaitForFileIndexing poll {Attempt} — parse error: {Msg}", i + 1, ex.Message);
                }
            }

            _logger.LogWarning("[bg] WaitForFileIndexing timed out after {Max} attempts — sending query anyway.", maxAttempts);
        }

        public async Task<(string Reply, List<GeneratedFile> Files, string MessageId)> SendMessageAsync(string conversationId, string query)
        {
            await EnsureAuthenticatedAsync();

            var postUrl = $"https://{_domain}/magicplatform/v1/genai/conversation/addmessage";
            object payload = new { conversation_id = conversationId, query = query };

            using var request = new HttpRequestMessage(HttpMethod.Post, postUrl);
            SetAuthHeaders(request);
            request.Content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");

            var response = await _http.SendAsync(request);
            var postJson = await response.Content.ReadAsStringAsync();

            if (!response.IsSuccessStatusCode)
                throw new Exception($"[bg] Send message failed ({response.StatusCode}): {postJson}");

            dynamic? postData = JsonConvert.DeserializeObject(postJson);
            string? messageId = postData?.message_id;

            if (string.IsNullOrEmpty(messageId))
                throw new Exception($"[bg] No message_id received. Raw: {postJson}");

            var (reply, files, _) = await PollForResponseAsync(conversationId, messageId);
            return (reply, files, messageId);
        }

        private async Task DeleteFileAsync(string conversationId, string fileId)
        {
            if (string.IsNullOrEmpty(fileId)) return;
            var deleteUrl = $"https://{_domain}/magicplatform/v1/genai/conversation/deletefile?conversation_id={conversationId}&file_id={fileId}";
            using var request = new HttpRequestMessage(HttpMethod.Delete, deleteUrl);
            SetAuthHeaders(request);
            await _http.SendAsync(request);
        }

        private async Task<(string Reply, List<GeneratedFile> Files, string MessageContentId)> PollForResponseAsync(string conversationId, string messageId)
        {
            const int maxAttempts = 400;
            bool reauthAttempted = false;

            for (int i = 0; i < maxAttempts; i++)
            {
                await Task.Delay(3000);

                var getUrl = $"https://{_domain}/magicplatform/v1/genai/conversation/response/{conversationId}/{messageId}";
                using var getRequest = new HttpRequestMessage(HttpMethod.Get, getUrl);
                SetAuthHeaders(getRequest);

                var getResponse = await _http.SendAsync(getRequest);
                var getJson = await getResponse.Content.ReadAsStringAsync();

                _logger.LogInformation("[Conversation] Poll attempt {Attempt} ({Status}): {Body}", i + 1, getResponse.StatusCode, getJson);

                bool looksLikeHtml = getJson.TrimStart().StartsWith("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
                                      || getJson.TrimStart().StartsWith("<html", StringComparison.OrdinalIgnoreCase);

                if ((getResponse.StatusCode == System.Net.HttpStatusCode.Unauthorized || looksLikeHtml) && !reauthAttempted)
                {
                    _logger.LogWarning("[Conversation][bg] Poll got non-JSON/401 response — re-authenticating once and retrying.");
                    reauthAttempted = true;
                    _token = null;
                    await EnsureAuthenticatedAsync();
                    continue;
                }

                if (!getResponse.IsSuccessStatusCode || looksLikeHtml) continue;

                var data = JsonConvert.DeserializeObject<JObject>(getJson);
                var contentArray = data?["message_content"] as JArray;
                var content = contentArray?.FirstOrDefault();
                string? status = content?["status"]?.ToString();

                if (status == "COMPLETED")
                {
                    string reply = content?["response"]?.ToString() ?? "No text found in response field.";
                    string msgContentId = content?["message_content_id"]?.ToString() ?? "";

                    // FIX: was hardcoded to new List<GeneratedFile>() — now actually parses
                    // artifacts_generated.files, same logic as ConversationAgentService's
                    // PollForResponseAsync. This is the exact reason the UI never showed a
                    // download link even though your log showed a real "created" file entry.
                    var files = new List<GeneratedFile>();
                    var filesArray = content?["artifacts_generated"]?["files"] as JArray;
                    if (filesArray != null)
                    {
                        foreach (var f in filesArray)
                        {
                            // FIX: accept "not_modified" in addition to "created"
                            var fileStatus = f["status"]?.ToString();
                            if (fileStatus == "created" || fileStatus == "not_modified")
                            {
                                files.Add(new GeneratedFile
                                {
                                    FileName = f["file_name"]?.ToString() ?? "",
                                    MimeType = f["mime_type"]?.ToString() ?? "",
                                    MessageContentId = msgContentId
                                });
                            }
                        }
                    }

                    return (reply, files, msgContentId);
                }

                if (status == "FAILED" || status == "ERROR")
                    throw new Exception($"[bg] Agent returned failure status. Raw: {getJson}");
            }

            return ("The agent timed out. Please try again.", new List<GeneratedFile>(), "");
        }
    }

    public class GeneratedFile
    {
        public string FileName { get; set; } = "";
        public string MimeType { get; set; } = "";
        public string? MessageContentId { get; set; }
        public string? DownloadUrl { get; set; }
    }
}