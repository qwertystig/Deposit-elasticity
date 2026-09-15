using Microsoft.AspNetCore.Http;

namespace DepositElasticity.Services
{
    public interface IConversationAgentService
    {
        Task<string> CreateConversationAsync(string assetId);

        Task<(string Reply, string MessageId, List<GeneratedFile> Files)> SendMessageAsync(
            string conversationId, string query, string? refFileId = null);

        Task<(string FileRefId, string FileId, string Status)> UploadFileAsync(string conversationId, IFormFile file);
        Task<bool> DeleteFileAsync(string conversationId, string fileId);

        Task<(string Reply, string FileId)> SendMessageWithAttachmentAsync(
            string conversationId, string query, IFormFile file, string? previousFileId);

        Task<byte[]> DownloadGeneratedFileAsync(string conversationId, string messageId, string messageContentId, string fileName);

        void StartBackgroundSend(string traceId, string conversationId, string query,
            byte[]? fileBytes, string? fileName, string? contentType, string? previousFileId);

        Task<(byte[] Bytes, string ContentType, string FileName)> FetchDmsDocumentAsync(string docDataId);

        ConversationJobStatus? GetJobStatus(string traceId);
    }

    public class ConversationJobStatus
    {
        public string Status { get; set; } = "PENDING"; // PENDING | COMPLETED | FAILED
        public string? Reply { get; set; }
        public string? NewFileId { get; set; }
        public string? Error { get; set; }

        // NEW — needed so the background job's generated files (artifacts_generated.files)
        // can reach the controller. MessageId is required because DownloadGeneratedFileAsync's
        // filedownload resolve call needs it as part of the URL path.
        public List<GeneratedFile>? Files { get; set; }
        public string? MessageId { get; set; }
    }
}