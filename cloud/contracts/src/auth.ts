export interface RegisterRequest {
  loginName: string;
  displayName: string;
  password: string;
}

export interface LoginRequest {
  loginName: string;
  password: string;
}

export interface UserSummaryDto {
  id: string;
  displayName: string;
}

export interface CurrentUserDto extends UserSummaryDto {
  loginName: string;
  createdAt: string;
}

export interface AuthSessionDto {
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  user: CurrentUserDto;
}

/** `GET /v2/users`：全部用户，按显示名排序；供负责人选择器使用。 */
export interface ListUsersResponse {
  items: UserSummaryDto[];
}
