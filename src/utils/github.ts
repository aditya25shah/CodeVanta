import { GitHubRepo, GitHubBranch, GitHubFile, GitHubCommit, GitHubUser } from '../types/github';

const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubAPI {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async request(endpoint: string, options: RequestInit = {}) {
    const response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `token ${this.token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json();
  }

  async getUser(): Promise<GitHubUser> {
    return this.request('/user');
  }

  async getRepositories(): Promise<GitHubRepo[]> {
    return this.request('/user/repos?sort=updated&per_page=100');
  }

  async getRepository(name: string): Promise<GitHubRepo> {
    const user = await this.getUser();
    return this.request(`/repos/${user.login}/${name}`);
  }

  async checkRepositoryExists(name: string): Promise<boolean> {
    try {
      const user = await this.getUser();
      await this.request(`/repos/${user.login}/${name}`);
      return true;
    } catch (error) {
      return false;
    }
  }

  async createRepository(name: string, description: string, isPrivate: boolean): Promise<GitHubRepo> {
    return this.request('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        private: isPrivate,
        auto_init: true,
      }),
    });
  }

  async getBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    return this.request(`/repos/${owner}/${repo}/branches`);
  }

  async getRepoContents(owner: string, repo: string, path: string = '', branch: string = 'main'): Promise<GitHubFile[]> {
    try {
      const contents = await this.request(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      
      // Handle both single file and array responses
      if (Array.isArray(contents)) {
        return contents.map(item => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size,
          sha: item.sha,
          download_url: item.download_url,
        }));
      } else {
        // Single file response
        return [{
          name: contents.name,
          path: contents.path,
          type: contents.type,
          size: contents.size,
          sha: contents.sha,
          download_url: contents.download_url,
        }];
      }
    } catch (error) {
      console.error(`Failed to get repository contents for ${owner}/${repo}/${path}:`, error);
      throw error;
    }
  }

  async getFileContent(owner: string, repo: string, path: string, branch: string = 'main'): Promise<string> {
    try {
      const response = await this.request(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
      
      if (response.content) {
        // Decode base64 content
        return atob(response.content.replace(/\n/g, ''));
      } else if (response.download_url) {
        // For large files, use download URL
        const fileResponse = await fetch(response.download_url);
        return await fileResponse.text();
      } else {
        throw new Error('Unable to retrieve file content');
      }
    } catch (error) {
      console.error(`Failed to get file content for ${owner}/${repo}/${path}:`, error);
      throw error;
    }
  }

  async getCommits(owner: string, repo: string, branch: string = 'main'): Promise<GitHubCommit[]> {
    return this.request(`/repos/${owner}/${repo}/commits?sha=${branch}&per_page=10`);
  }

  async createFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string = 'main'
  ): Promise<any> {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))), // Handle UTF-8 encoding properly
      branch,
    };

    return this.request(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async updateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    sha?: string,
    branch: string = 'main'
  ): Promise<any> {
    // If no SHA provided, try to get it
    if (!sha) {
      try {
        const fileInfo = await this.request(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
        sha = fileInfo.sha;
      } catch (error) {
        // File doesn't exist, create it instead
        return this.createFile(owner, repo, path, content, message, branch);
      }
    }

    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))), // Handle UTF-8 encoding properly
      branch,
      sha,
    };

    return this.request(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async deleteFile(
    owner: string,
    repo: string,
    path: string,
    message: string,
    sha: string,
    branch: string = 'main'
  ): Promise<any> {
    const body = {
      message,
      sha,
      branch,
    };

    return this.request(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'DELETE',
      body: JSON.stringify(body),
    });
  }

  async createBranch(owner: string, repo: string, newBranch: string, fromSha: string): Promise<any> {
    return this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${newBranch}`,
        sha: fromSha,
      }),
    });
  }

  async uploadMultipleFiles(
    owner: string,
    repo: string,
    files: Array<{ path: string; content: string; name: string }>,
    branch: string = 'main'
  ): Promise<void> {
    for (const file of files) {
      try {
        await this.createFile(
          owner,
          repo,
          file.path,
          file.content,
          `Add ${file.name}`,
          branch
        );
      } catch (error) {
        // If file exists, try to update it
        try {
          const fileInfo = await this.request(`/repos/${owner}/${repo}/contents/${file.path}?ref=${branch}`);
          await this.updateFile(
            owner,
            repo,
            file.path,
            file.content,
            `Update ${file.name}`,
            fileInfo.sha,
            branch
          );
        } catch (updateError) {
          console.error(`Failed to upload ${file.name}:`, updateError);
          throw updateError;
        }
      }
    }
  }

  // Helper method to get repository tree (for better performance with large repos)
  async getRepositoryTree(owner: string, repo: string, branch: string = 'main', recursive: boolean = false): Promise<any> {
    try {
      const branchInfo = await this.request(`/repos/${owner}/${repo}/branches/${branch}`);
      const treeSha = branchInfo.commit.sha;
      
      return this.request(`/repos/${owner}/${repo}/git/trees/${treeSha}${recursive ? '?recursive=1' : ''}`);
    } catch (error) {
      console.error(`Failed to get repository tree for ${owner}/${repo}:`, error);
      throw error;
    }
  }
}